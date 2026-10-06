import type { Pr, PrChecks, PrRef, PrReview, PrState, PrStatus } from '../types'
import { findPrUrls, uniqueRefs } from './detect'
import type { Cli, CliLookup } from './detect'

const PR_STATES: readonly string[] = ['open', 'draft', 'merged', 'closed'] satisfies PrState[]

/**
 * The band's list as this version reads it. State outlives a reload, so entries an older
 * version wrote are rebuilt from their URL, and a status of another shape is asked again.
 */
export function normalize(list: readonly unknown[]): Pr[] {
  const prs: Pr[] = []
  for (const entry of list) {
    const { url, status } = (entry ?? {}) as { url?: unknown; status?: unknown }
    const ref = typeof url === 'string' ? findPrUrls(url)[0] : undefined
    if (ref) prs.push({ ...ref, status: readStatus(status) })
  }
  return uniqueRefs(prs)
}

/** A status kept by this or another version, or null when it is not one this version can draw. */
export function readStatus(value: unknown): PrStatus | null {
  const status = value as Partial<PrStatus> | null | undefined
  return typeof status?.title === 'string' && PR_STATES.includes(String(status.state)) ? (status as PrStatus) : null
}

const GH_FIELDS = 'title,state,isDraft,reviewDecision,statusCheckRollup'

/** The command that reports a PR's status, or null where no supported CLI covers its provider. */
export function statusCommand(ref: PrRef): string[] | null {
  switch (ref.provider) {
    case 'github':
      return ['gh', 'pr', 'view', ref.url, '--json', GH_FIELDS]
    case 'gitlab':
      return ['glab', 'mr', 'view', String(ref.number), '-R', projectUrl(ref.url), '-F', 'json']
    default:
      return null
  }
}

/** The command that turns a PR named by number or branch into its URL. */
export function lookupCommand(lookup: CliLookup): string[] {
  const selector = lookup.selector === undefined ? [] : [lookup.selector]
  return lookup.cli === 'gh'
    ? ['gh', 'pr', 'view', ...selector, ...(lookup.repo ? ['--repo', lookup.repo] : []), '--json', 'url']
    : ['glab', 'mr', 'view', ...selector, ...(lookup.repo ? ['-R', lookup.repo] : []), '-F', 'json']
}

export function parseLookup(cli: Cli, stdout: string): string | null {
  const json = parseJson(stdout)
  const url = cli === 'gh' ? json?.url : json?.web_url
  return typeof url === 'string' ? url : null
}

export function parseStatus(ref: PrRef, stdout: string): PrStatus | null {
  const json = parseJson(stdout)
  if (!json) return null
  return ref.provider === 'gitlab' ? parseGlab(json) : parseGh(json)
}

function parseGh(pr: Record<string, unknown>): PrStatus | null {
  const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.state === 'OPEN' ? (pr.isDraft ? 'draft' : 'open') : null
  if (!state) return null
  const review: Record<string, PrReview> = {
    APPROVED: 'approved',
    CHANGES_REQUESTED: 'changes_requested',
    REVIEW_REQUIRED: 'review_required',
  }
  const rollup = Array.isArray(pr.statusCheckRollup) ? (pr.statusCheckRollup as Array<Record<string, unknown>>) : []
  return {
    title: String(pr.title ?? ''),
    state,
    review: review[String(pr.reviewDecision)] ?? null,
    checks: rollup.length > 0 ? countChecks(rollup.map(check => String(check.conclusion || check.state || ''))) : null,
  }
}

function parseGlab(mr: Record<string, unknown>): PrStatus | null {
  const states: Record<string, PrState> = { opened: 'open', merged: 'merged', closed: 'closed', locked: 'closed' }
  let state = states[String(mr.state)]
  if (!state) return null
  if (state === 'open' && (mr.draft || mr.work_in_progress)) state = 'draft'
  const reviews: Record<string, PrReview> = { not_approved: 'review_required', requested_changes: 'changes_requested' }
  const pipeline = (mr.head_pipeline ?? mr.pipeline) as Record<string, unknown> | null | undefined
  return {
    title: String(mr.title ?? ''),
    state,
    review: reviews[String(mr.detailed_merge_status)] ?? null,
    checks: pipeline?.status ? countChecks([String(pipeline.status)]) : null,
  }
}

/** Counts check results, GitHub's conclusions and GitLab's pipeline statuses alike. */
export function countChecks(results: readonly string[]): PrChecks {
  const checks: PrChecks = { passed: 0, failed: 0, pending: 0 }
  for (const result of results.map(r => r.toUpperCase())) {
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(result)) checks.passed++
    else if (['FAILURE', 'FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED'].includes(result)) checks.failed++
    else checks.pending++
  }
  return checks
}

/** `https://host/group/project` from a merge request URL. */
function projectUrl(url: string): string {
  return url.slice(0, url.indexOf('/-/merge_requests/'))
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}
