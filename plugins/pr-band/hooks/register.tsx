import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pr, PrRef, PrState, PrStatus } from '../types'
import { findPrUrls, prLabel, prsInBashCall, repoName, uniqueRefs } from './detect'
import type { Cli, CliLookup } from './detect'
import { lookupCommand, normalize, parseLookup, parseStatus, readStatus, statusCommand } from './status'

const prs = atom({ plugin: 'pr-band', key: 'prs' } as const, [] as Pr[])
const showClosed = atom({ plugin: 'pr-band', key: 'showClosed' } as const, false)
const isCompact = atom({ plugin: 'pr-band', key: 'isCompact' } as const, false)

// How often the timer looks for statuses gone stale; a PR is asked at most once per refresh interval.
const TICK_MS = 60_000
const DEFAULT_REFRESH_MINUTES = 5
// With no prompt, turn or tool call for this long, the timer asks nothing until the next one.
const IDLE_MS = 15 * 60_000
// A PR a command just acted on, or a press on the band, is asked again unless it was this recently.
const RECENT_MS = 20_000
// Statuses are kept in the store per PR, shared by every session; older ones are dropped.
const STATUS_KEY = 'status:'
const STATUS_KEEP_MS = 7 * 24 * 60 * 60_000
const CLI_TIMEOUT_MS = 15_000
// A CLI that could not start is left alone this long before it is tried again.
const CLI_RETRY_MS = 10 * 60_000
// Lookups by number made while catching up on the history, at most.
const HISTORY_LOOKUPS = 20
const STORED_SESSIONS = 50

const STATE_COLOR: Record<PrState, string> = {
  open: 'success',
  draft: 'inactive',
  merged: 'merged',
  closed: 'error',
}

const REVIEW_LABEL = {
  approved: 'approved',
  changes_requested: 'changes requested',
  review_required: 'review required',
} as const

type StoredSessions = Record<string, { refs: PrRef[]; seenAt: number }>
type StoredStatus = { status: PrStatus | null; fetchedAt: number }

let refreshMs = DEFAULT_REFRESH_MINUTES * 60_000
let lastActivityAt = 0
const unavailableUntil = new Map<Cli, number>()
// What the last status call for each PR came to, for `/pr-band why`.
const lastOutcome = new Map<string, string>()
let isRefreshing = false

const isFinal = (pr: Pr) => pr.status?.state === 'merged' || pr.status?.state === 'closed'

function colorOf(pr: Pr): string | undefined {
  if (!pr.status) return undefined
  return pr.status.checks?.failed ? 'error' : STATE_COLOR[pr.status.state]
}

function summary(pr: Pr): string {
  const { status } = pr
  if (!status) return 'no status'
  const parts: string[] = [status.state]
  if (status.review && !isFinal(pr)) parts.push(REVIEW_LABEL[status.review])
  if (status.checks && !isFinal(pr)) parts.push(checksText(status))
  return parts.join(' · ')
}

function checksText(status: PrStatus): string {
  const { passed, failed, pending } = status.checks ?? { passed: 0, failed: 0, pending: 0 }
  return `${failed > 0 ? `✗${failed} ` : ''}${pending > 0 ? `…${pending} ` : ''}✓${passed}`
}

type CliOutcome = { stdout: string } | { failure: string }

/** Runs a provider CLI and never throws, so a missing or logged-out CLI only costs the status. */
async function runCli($: EngineInterface, argv: string[], cwd?: string): Promise<CliOutcome> {
  const cli = argv[0] as Cli
  const retryAt = unavailableUntil.get(cli) ?? 0
  if (retryAt > (await $.clock.now())) return { failure: `${cli} could not start earlier; not tried again yet` }
  try {
    const { exitCode, stdout, stderr } = await $.process.run(argv, {
      timeoutMs: CLI_TIMEOUT_MS,
      ...(cwd ? { cwd: await absolutePath($, cwd) } : {}),
    })
    if (exitCode === 0) return { stdout }
    return { failure: `${cli} exited ${exitCode}: ${firstLine(stderr) || firstLine(stdout) || 'no output'}` }
  } catch (error) {
    unavailableUntil.set(cli, (await $.clock.now()) + CLI_RETRY_MS)
    return { failure: `${cli} could not run: ${firstLine(String(error))}` }
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 200) ?? ''
}

async function absolutePath($: EngineInterface, path: string): Promise<string> {
  if (path.startsWith('/')) return path
  if (path === '~' || path.startsWith('~/')) return `${(await $.env.get('HOME')) ?? ''}${path.slice(1)}`
  return `${await $.session.cwd()}/${path}`
}

async function lookUp($: EngineInterface, lookups: readonly CliLookup[]): Promise<PrRef[]> {
  const found: PrRef[] = []
  for (const lookup of lookups) {
    const outcome = await runCli($, lookupCommand(lookup), lookup.cwd)
    const url = 'stdout' in outcome ? parseLookup(lookup.cli, outcome.stdout) : null
    if (url) found.push(...findPrUrls(url))
  }
  return found
}

async function fetchStatus($: EngineInterface, ref: PrRef): Promise<PrStatus | null> {
  const argv = statusCommand(ref)
  if (!argv) {
    lastOutcome.set(ref.url, `no CLI reports ${ref.provider} status`)
    return null
  }
  const outcome = await runCli($, argv)
  if ('failure' in outcome) {
    lastOutcome.set(ref.url, outcome.failure)
    return null
  }
  const status = parseStatus(ref, outcome.stdout)
  lastOutcome.set(ref.url, status ? 'ok' : `unreadable ${argv[0]} output: ${firstLine(outcome.stdout) || 'empty'}`)
  return status
}

async function persist($: EngineInterface) {
  const sessionId = await $.session.id()
  const refs = (await read($, prs)).map(({ url, repo, number, provider }) => ({ url, repo, number, provider }))
  const sessions = ((await $.store.get('sessions')) ?? {}) as StoredSessions
  sessions[sessionId] = { refs, seenAt: await $.clock.now() }
  const kept = Object.entries(sessions)
    .sort(([, a], [, b]) => b.seenAt - a.seenAt)
    .slice(0, STORED_SESSIONS)
  await $.store.set('sessions', Object.fromEntries(kept))
}

async function storedRefs($: EngineInterface): Promise<PrRef[]> {
  const sessions = ((await $.store.get('sessions')) ?? {}) as StoredSessions
  return normalize(sessions[await $.session.id()]?.refs ?? [])
}

/** Adds the PRs not yet in the band, in the order given, and gets their status. */
async function addRefs($: EngineInterface, refs: readonly PrRef[]) {
  const known = new Set((await read($, prs)).map(pr => pr.url))
  const added = uniqueRefs(refs).filter(ref => !known.has(ref.url))
  if (added.length === 0) return
  await update($, prs, list => uniqueRefs<Pr>([...list, ...added.map(ref => ({ ...ref, status: null }))]))
  await persist($)
  await refreshStatuses($, refreshMs, new Set(added.map(ref => ref.url)))
}

/**
 * A PR's status no older than `maxAgeMs`: the stored one when it is recent enough, whichever
 * session fetched it, else a fresh one. Null when there is nothing to show.
 */
async function statusFor($: EngineInterface, pr: Pr, maxAgeMs: number): Promise<PrStatus | null> {
  const key = `${STATUS_KEY}${pr.url}`
  const now = await $.clock.now()
  const stored = (await $.store.get(key)) as StoredStatus | undefined
  if (stored && now - stored.fetchedAt < maxAgeMs) return readStatus(stored.status)
  // A failed ask keeps the last status and still counts as an ask, so a failing CLI is not hammered.
  const status = (await fetchStatus($, pr)) ?? readStatus(stored?.status)
  await $.store.set(key, { status, fetchedAt: now } satisfies StoredStatus)
  return status
}

/**
 * Brings each open PR's status (or only those of `urls`) to no older than `maxAgeMs`.
 * Only a status that changed redraws the band.
 */
async function refreshStatuses($: EngineInterface, maxAgeMs: number, urls?: ReadonlySet<string>) {
  const due = (await read($, prs)).filter(pr => (urls ? urls.has(pr.url) : !isFinal(pr)))
  const answers = await Promise.all(due.map(async pr => [pr, await statusFor($, pr, maxAgeMs)] as const))
  const changed = new Map(
    answers
      .filter(([pr, status]) => status !== null && JSON.stringify(status) !== JSON.stringify(pr.status))
      .map(([pr, status]) => [pr.url, status]),
  )
  if (changed.size === 0) return
  await update($, prs, list => list.map(pr => (changed.has(pr.url) ? { ...pr, status: changed.get(pr.url) ?? null } : pr)))
}

async function markActive($: EngineInterface) {
  lastActivityAt = await $.clock.now()
}

/** The timer: asks for stale statuses while the session is in use, nothing while it is idle. */
async function tick($: EngineInterface) {
  if ((await $.clock.now()) - lastActivityAt > IDLE_MS) return
  await refreshStatuses($, refreshMs)
}

/** A press on the band: the person is looking at it, so it is brought up to date. */
async function refreshFromBand($: EngineInterface) {
  await markActive($)
  await refreshStatuses($, RECENT_MS)
}

/** Every button of the band refreshes it on the way, besides its own action. */
async function pressed($: EngineInterface, action?: Promise<unknown>) {
  await action
  await refreshFromBand($).catch(() => {})
}

async function pruneStatuses($: EngineInterface) {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith(STATUS_KEY)) continue
    const stored = (await $.store.get(key)) as StoredStatus | undefined
    if (!stored || now - stored.fetchedAt > STATUS_KEEP_MS) await $.store.delete(key)
  }
}

/** The PRs in the conversation so far: its Bash calls, and what its subagents reported. */
async function scanHistory($: EngineInterface): Promise<PrRef[]> {
  const conversations = [await $.session.messages()]
  for (const agent of await $.agent.list()) {
    const messages = await $.session.messages({ agentId: agent.id })
    if (Array.isArray(messages)) conversations.push(messages)
  }

  const refs: PrRef[] = []
  const lookups: CliLookup[] = []
  for (const messages of conversations) {
    if (!Array.isArray(messages)) continue
    for (const message of messages) {
      for (const use of message.toolUses ?? []) {
        if (use.tool === 'Bash') {
          const result = use.result as { gitOperation?: { pr?: { number: number; url?: string } } } | undefined
          const found = prsInBashCall(String(use.input.command ?? ''), use.text ?? '', result?.gitOperation?.pr)
          refs.push(...found.refs)
          lookups.push(...found.lookups)
        } else if (use.tool === 'Agent' || use.tool === 'Task') {
          // A finished subagent's own calls are gone; its report usually names what it opened.
          refs.push(...findPrUrls(use.text ?? ''))
        }
      }
    }
  }
  return [...refs, ...(await lookUp($, lookups.slice(0, HISTORY_LOOKUPS)))]
}

async function catchUp($: EngineInterface) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    await addRefs($, [...(await storedRefs($)), ...(await scanHistory($))])
    await refreshStatuses($, refreshMs)
  } catch (error) {
    $.ui.log(`pr-band: catching up failed: ${String(error)}`, { to: 'debug' })
  } finally {
    isRefreshing = false
  }
}

/** A Bash call named these PRs and may have changed them: they, and only they, are asked again. */
async function capture($: EngineInterface, found: ReturnType<typeof prsInBashCall>) {
  try {
    const refs = [...found.refs, ...(await lookUp($, found.lookups))]
    if (refs.length === 0) return
    await addRefs($, refs)
    await refreshStatuses($, RECENT_MS, new Set(refs.map(ref => ref.url)))
  } catch (error) {
    $.ui.log(`pr-band: reading a Bash call failed: ${String(error)}`, { to: 'debug' })
  }
}

async function setCompact($: EngineInterface, value: boolean) {
  await update($, isCompact, () => value)
  await $.store.set('isCompact', value)
}

export const register: Register = (on, options) => {
  const minutes = Number(options.refreshMinutes ?? DEFAULT_REFRESH_MINUTES)
  refreshMs = Math.min(Math.max(Number.isFinite(minutes) ? minutes : DEFAULT_REFRESH_MINUTES, 1), 60) * 60_000

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pr-band',
      description: 'PR band: refresh, toggle merged/closed PRs, toggle compact view, or clear the list',
      argumentHint: '[refresh | merged | compact | clear | why]',
    })
    const storedCompact = Boolean(await $.store.get('isCompact'))
    await update($, isCompact, () => storedCompact)
    await update($, prs, list => normalize(list))
    await markActive($)
    $.clock.every(TICK_MS, () => void tick($).catch(() => {}))
    void catchUp($)
    void pruneStatuses($).catch(() => {})
    return next(e)
  })

  // The first prompt after a break brings stale statuses up to date before the timer would.
  on('prompt.submit', async ($, e, next) => {
    await markActive($)
    void refreshStatuses($, refreshMs).catch(() => {})
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await markActive($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await markActive($)
    return next(e)
  })

  // Every Bash call, a subagent's included, may name a PR or change one's state.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const answer = await next(e)
    if (answer.deny === undefined) {
      const result = answer.result as { gitOperation?: { pr?: { number: number; url?: string } } } | undefined
      void capture($, prsInBashCall(e.command, answer.text ?? '', result?.gitOperation?.pr))
    }
    return answer
  })

  on('command.run', { command: 'pr-band' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'merged') {
      await update($, showClosed, shown => !shown)
      return { text: 'Toggled merged/closed PRs in the band.' }
    }
    if (arg === 'compact') {
      await setCompact($, !(await read($, isCompact)))
      return { text: 'Toggled the compact PR band.' }
    }
    if (arg === 'clear') {
      await update($, prs, () => [])
      await persist($)
      return { text: 'Cleared the PR band for this session.' }
    }
    if (arg === 'why') {
      await refreshStatuses($, 0, new Set((await read($, prs)).map(pr => pr.url)))
      const lines = (await read($, prs)).map(pr => `${pr.url}: ${lastOutcome.get(pr.url) ?? 'not asked yet'}`)
      return { text: lines.length > 0 ? lines.join('\n') : 'No PRs in the band yet.' }
    }
    if (arg !== '' && arg !== 'refresh') {
      return { text: `Unknown argument "${arg}". Use refresh, merged, compact, clear or why.` }
    }
    await catchUp($)
    await refreshStatuses($, RECENT_MS)
    const list = await read($, prs)
    const withStatus = list.filter(pr => pr.status).length
    return { text: `PR band: ${list.length} PR(s), ${withStatus} with status.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const all = await read($, prs)
    if (all.length === 0) return next(e)

    const isShowingClosed = await read($, showClosed)
    const open = all.filter(pr => !isFinal(pr))
    const closed = all.filter(isFinal)
    const shown = isShowingClosed ? [...open, ...closed] : open
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const scopeOf = (pr: Pr) => `pr-${pr.url}`.slice(-64)

    if (await read($, isCompact)) {
      // A hovered PR's details are drawn over the rest of the row, right after the labels.
      const labelsWidth = shown.reduce((width, pr) => width + prLabel(pr).length + 1, 0)
      const detailWidth = Math.max(e.props.bodyColumns - labelsWidth, 0)
      return (
        <Box flexDirection="row" gap={1} width={e.props.bodyColumns}>
          {shown.map(pr => (
            <Box key={pr.url}>
              <Text color={colorOf(pr)} hover={{ scope: scopeOf(pr), bold: true, inverse: true }}>
                <Link href={pr.url} label={prLabel(pr)} />
              </Text>
            </Box>
          ))}
          {closed.length > 0 && !isShowingClosed ? <Text dimColor>+{closed.length} merged/closed</Text> : null}
          <Button key="expand" plain dimColor label="▾ details" onPress={() => pressed($, setCompact($, false))} />
          <Button key="refresh" plain dimColor label="↻" onPress={() => pressed($)} />
          {/* Last, so they paint over the rest of the row. */}
          {shown.map(pr => (
            <Box
              key={`detail-${pr.url}`}
              position="absolute"
              top={0}
              left={labelsWidth}
              width={detailWidth}
              display="none"
              hover={{ scope: scopeOf(pr), display: 'flex' }}
            >
              <Text wrap="truncate-end">
                {[repoName(pr), summary(pr), pr.status?.title].filter(Boolean).join(' · ').padEnd(detailWidth)}
              </Text>
            </Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        {shown.map(pr => {
          const { status } = pr
          const isDim = isFinal(pr)
          return (
            <Box key={pr.url} flexDirection="row" gap={1}>
              <Text color={colorOf(pr)}>●</Text>
              <Text bold={!isDim} dimColor={isDim} hover={{ scope: scopeOf(pr), underline: true, dimColor: false }}>
                <Link href={pr.url} label={`${repoName(pr)} ${prLabel(pr)}`} />
              </Text>
              {status ? <Text color={STATE_COLOR[status.state]}>{status.state}</Text> : <Text dimColor>no status</Text>}
              {status?.review && !isDim ? (
                <Text color={status.review === 'approved' ? 'success' : 'warning'}>{REVIEW_LABEL[status.review]}</Text>
              ) : null}
              {status?.checks && !isDim ? <Text dimColor>{checksText(status)}</Text> : null}
              {status?.title ? (
                <Box flexShrink={1}>
                  <Text dimColor wrap="truncate-end">{status.title}</Text>
                </Box>
              ) : null}
            </Box>
          )
        })}
        <Box flexDirection="row" gap={2}>
          {closed.length > 0 ? (
            <Button
              key="toggle-closed"
              plain
              dimColor
              label={isShowingClosed ? `hide ${closed.length} merged/closed` : `+ ${closed.length} merged/closed`}
              onPress={() => pressed($, update($, showClosed, isShown => !isShown))}
            />
          ) : null}
          <Button key="compact" plain dimColor label="▴ compact" onPress={() => pressed($, setCompact($, true))} />
          <Button key="refresh" plain dimColor label="↻ refresh" onPress={() => pressed($)} />
        </Box>
      </Box>
    )
  })
}
