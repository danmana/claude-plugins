export type PrProvider = 'github' | 'gitlab' | 'bitbucket' | 'gerrit'

/** A pull/merge request, as found in a command or its output. */
export type PrRef = {
  url: string
  /** The path between the host and the PR segment: `owner/repo`, `group/sub/project`. */
  repo: string
  number: number
  provider: PrProvider
}

export type PrState = 'open' | 'draft' | 'merged' | 'closed'

export type PrReview = 'approved' | 'changes_requested' | 'review_required'

export type PrChecks = { passed: number; failed: number; pending: number }

/** What a provider CLI reported; absent when no CLI could be asked. */
export type PrStatus = {
  title: string
  state: PrState
  review: PrReview | null
  checks: PrChecks | null
}

export type Pr = PrRef & { status: PrStatus | null }

declare module 'claude-code' {
  interface PluginState {
    'pr-band': {
      prs: Pr[]
      showClosed: boolean
      isCompact: boolean
    }
  }
}
