import type { On, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

const OPEN = 'https://github.com/acme/app/pull/12'
const MERGED = 'https://github.com/acme/app/pull/11'
const MR = 'https://gitlab.com/acme/web/-/merge_requests/3'

const BAND = {
  plugin: 'pr-band',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const ran = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const GH = {
  [OPEN]: { title: 'Add search', state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [{ conclusion: 'SUCCESS' }] },
  [MERGED]: { title: 'Fix typo', state: 'MERGED', isDraft: false, reviewDecision: '', statusCheckRollup: [] },
} as Record<string, unknown>

const T0 = 1_000_000
const MINUTE = 60_000

// What the engine answers beneath the plugin, besides each test's own conversation and CLIs.
function standIn(on: On, stored: Record<string, unknown> = {}) {
  mock.store(on, stored)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('command.register', () => ({ value: { command: 'pr-band' } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('agent.list', () => ({ value: [] }))
  return mock.clock(on, { now: T0 })
}

/** Answers Bash with `output`, and gh as GH holds each PR; counts the status asks per PR. */
function github(on: On, output: (command: string) => string, history: SessionMessage[] = []) {
  const asked: string[] = []
  on('session.messages', () => ({ value: history }))
  on('tool.call', (_, e) => {
    const text = output(String((e as { command?: string }).command))
    return { result: { stdout: text, stderr: '', interrupted: false }, text }
  })
  on('process.run', (_, e) => {
    const [, , , target] = e.argv
    if (e.argv.includes('url')) return ran(JSON.stringify({ url: target === '11' ? MERGED : OPEN }))
    asked.push(String(target))
    return GH[String(target)] ? ran(JSON.stringify(GH[String(target)])) : ran('', 1)
  })
  return asked
}

async function start($: Engine) {
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true } as never)
}

async function bash($: Engine, clock: MockClock, command: string) {
  await $.tool.call({ tool: 'Bash', command } as never)
  // The capture runs after the call answers; let it settle.
  await clock.advance(1)
}

test('PRs from Bash calls show with their status; merged ones fold away', async ($, on) => {
  const clock = standIn(on)
  on('session.messages', () => ({ value: [] }))
  on('tool.call', (_, e) => {
    const command = String((e as { command?: string }).command)
    const text = command.includes('create') ? `${OPEN}\n` : command.includes('merge') ? `merged ${MERGED}\n` : `${MR}\n`
    return { result: { stdout: text, stderr: '', interrupted: false }, text }
  })
  on('process.run', (_, e) => {
    const [cli, , , target] = e.argv
    if (cli === 'glab') return ran(JSON.stringify({ title: 'Tidy styles', state: 'opened', draft: false, head_pipeline: { status: 'failed' } }))
    return GH[String(target)] ? ran(JSON.stringify(GH[String(target)])) : ran('', 1)
  })

  await start($)
  await bash($, clock, 'gh pr create --fill')
  await bash($, clock, 'gh pr merge 11 --squash')
  await bash($, clock, 'glab mr view 3')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as never)
    expect(await ui.find({ type: 'Text', text: 'PRs' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'app #12' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'review required' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'web !3' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✗1 ✓0' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'app #11' })).toBeUndefined()

    await ui.press({ key: 'toggle-closed' })
    expect(await ui.find({ type: 'Link', text: 'app #11' })).toBeDefined()
    await ui.press({ key: 'toggle-closed' })

    await ui.press({ key: 'compact' })
    expect(await ui.find({ type: 'Text', text: 'PRs' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: '#12' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: '!3' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+1 merged/closed' })).toBeDefined()
    await ui.press({ key: 'expand' })
    await ui.unmount()
  }
})

test('without gh or glab the PRs still show, as plain links', async ($, on) => {
  const clock = standIn(on)
  on('session.messages', () => ({ value: [] }))
  on('tool.call', () => ({ result: { stdout: `${OPEN}\n${MR}\n`, stderr: '', interrupted: false }, text: `${OPEN}\n${MR}\n` }))
  on('process.run', () => {
    throw new Error('spawn gh ENOENT')
  })

  await start($)
  await bash($, clock, 'gh pr create --fill')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect(await ui.find({ type: 'Link', text: 'app #12' })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: 'web !3' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: 'no status' })).length).toBe(2)
  await ui.unmount()
})

test('PRs from before the plugin loaded are picked up from the conversation', async ($, on) => {
  const clock = standIn(on)
  const history: SessionMessage[] = [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: { command: 'gh pr create --fill' }, text: `${OPEN}\n` }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'Agent', input: {}, text: `Opened ${MR} for the styles.` }] },
  ]
  on('session.messages', () => ({ value: history }))
  on('process.run', () => ran('', 1))

  await start($)
  await clock.advance(1)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect(await ui.find({ type: 'Link', text: 'app #12' })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: 'web !3' })).toBeDefined()
  await ui.unmount()
})

test('an open PR is asked again once per refresh interval, and not at all while idle', async ($, on) => {
  const clock = standIn(on)
  const asked = github(on, () => `${OPEN}\n`)

  await start($)
  await bash($, clock, 'gh pr create --fill')
  expect(asked).toEqual([OPEN])

  await clock.advance(4 * MINUTE)
  expect(asked.length).toBe(1)
  await clock.advance(1 * MINUTE)
  expect(asked.length).toBe(2)

  // Last activity was the Bash call: the ticks at 10 and 15 minutes still ask, then the session is idle.
  await clock.advance(30 * MINUTE)
  expect(asked.length).toBe(4)

  // The first prompt after the break asks at once.
  await $.prompt.submit({ text: 'hi', wait: false } as never)
  await clock.advance(1)
  expect(asked.length).toBe(5)
})

test('a status another session fetched recently is used as is', async ($, on) => {
  const status = { title: 'Add search', state: 'open', review: 'approved', checks: null }
  const clock = standIn(on, { [`status:${OPEN}`]: { status, fetchedAt: T0 - MINUTE } })
  const history: SessionMessage[] = [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: { command: 'gh pr create --fill' }, text: `${OPEN}\n` }] },
  ]
  const asked = github(on, () => '', history)

  await start($)
  await clock.advance(1)
  expect(asked).toEqual([])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect(await ui.find({ type: 'Text', text: 'PR' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'approved' })).toBeDefined()
  await ui.unmount()
})

test('a command asks again only about the PR it named; a press on the band asks about all', async ($, on) => {
  const clock = standIn(on)
  const asked = github(on, command => (command.includes('create') ? `${OPEN}\n${MERGED}\n` : 'Merged.\n'))

  await start($)
  await bash($, clock, 'gh pr create --fill')
  expect(asked.sort()).toEqual([MERGED, OPEN])

  await clock.advance(MINUTE)
  await bash($, clock, 'gh pr comment 12 --body "ok"')
  expect(asked.filter(url => url === OPEN).length).toBe(2)
  expect(asked.filter(url => url === MERGED).length).toBe(1)

  // #11 is merged: a press refreshes the open ones only.
  await clock.advance(MINUTE)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  await ui.press({ key: 'refresh' })
  expect(asked.filter(url => url === OPEN).length).toBe(3)
  expect(asked.filter(url => url === MERGED).length).toBe(1)
  await ui.unmount()
})

test('the refresh interval is an install option', { options: { refreshMinutes: 1 } }, async ($, on) => {
  const clock = standIn(on)
  const asked = github(on, () => `${OPEN}\n`)

  await start($)
  await bash($, clock, 'gh pr create --fill')
  await clock.advance(MINUTE)
  expect(asked.length).toBe(2)
})
