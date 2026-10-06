import type { PrProvider, PrRef } from '../types'

// A pull/merge request page: GitHub and GitHub Enterprise (`/pull/N`), Bitbucket Cloud and
// Data Center (`/pull-requests/N`), GitLab hosted and self-managed (`/-/merge_requests/N`).
// Whatever follows the number (`/files`, `#discussion_r1`) is left off the URL. The links
// `git push` prints for opening a new one (`/pull/new/branch`) carry no number and never match.
const HOSTED_PR = /https?:\/\/[^\s/"'`<>()]+\/([^\s"'`<>()]+?)\/(pull|pull-requests|-\/merge_requests)\/(\d{1,9})(?!\d)/g

// A change on a Google-hosted Gerrit review site.
const GERRIT_CHANGE = /https:\/\/[a-z0-9-]+-review\.googlesource\.com\/c\/([\w.-]+(?:\/[\w.-]+)*)\/\+\/(\d{1,9})(?!\d)/g

const PROVIDER_BY_SEGMENT: Record<string, PrProvider> = {
  pull: 'github',
  'pull-requests': 'bitbucket',
  '-/merge_requests': 'gitlab',
}

// The text `gh pr merge` and friends print about a PR they acted on: `Merged pull request owner/repo#42`.
const PR_MENTION = /[Pp]ull request (?:(\S+?)#)?#?(\d{1,9})\b/

// Subcommands that act on an existing PR, so a number or the current branch names one.
const GH_PR_VERBS = new Set([
  'view', 'merge', 'close', 'reopen', 'ready', 'edit', 'comment', 'review',
  'checkout', 'checks', 'diff', 'lock', 'unlock', 'update-branch',
])
const GLAB_MR_VERBS = new Set([
  'view', 'merge', 'close', 'reopen', 'update', 'note', 'approve', 'revoke',
  'checkout', 'diff', 'rebase', 'subscribe', 'unsubscribe', 'todo',
])

export type Cli = 'gh' | 'glab'

/** A PR a command named only by number or branch: the CLI is asked for its URL. */
export type CliLookup = {
  cli: Cli
  /** A number or URL; absent for the PR of the current branch. */
  selector?: string
  /** `--repo` / `-R` as given. */
  repo?: string
  /** The directory the command ran in, when it `cd`'d first. */
  cwd?: string
}

export function uniqueRefs<T extends PrRef>(refs: readonly T[]): T[] {
  const seen = new Set<string>()
  return refs.filter(ref => !seen.has(ref.url) && seen.add(ref.url))
}

/** Every PR URL in the text, in the order they appear, each once. */
export function findPrUrls(text: string): PrRef[] {
  const found: Array<{ index: number; ref: PrRef }> = []
  for (const match of text.matchAll(HOSTED_PR)) {
    const [url, repo = '', segment = '', number = ''] = match
    const provider = PROVIDER_BY_SEGMENT[segment]
    if (provider) found.push({ index: match.index ?? 0, ref: { url, repo, number: Number(number), provider } })
  }
  for (const match of text.matchAll(GERRIT_CHANGE)) {
    const [url, repo = '', number = ''] = match
    found.push({ index: match.index ?? 0, ref: { url, repo, number: Number(number), provider: 'gerrit' } })
  }
  return uniqueRefs(found.sort((a, b) => a.index - b.index).map(({ ref }) => ref))
}

function unquote(token: string): string {
  return token.replace(/^(['"])(.*)\1$/, '$2')
}

function isSelector(token: string): boolean {
  return /^#?\d{1,9}$/.test(token) || /^https?:\/\//.test(token)
}

/**
 * The `gh pr <verb>` / `glab mr <verb>` calls in a shell command that act on an existing PR,
 * with the number, repo and directory each names. Quoting is read loosely: only a number
 * or a URL counts as the PR, so a flag's value is never mistaken for one.
 */
export function cliCalls(command: string): CliLookup[] {
  const calls: CliLookup[] = []
  let cwd: string | undefined
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = segment.trim().split(/\s+/).map(unquote)
    if (tokens[0] === 'cd' && tokens[1]) {
      cwd = tokens[1]
      continue
    }
    const start = tokens.findIndex(
      (token, i) =>
        (token === 'gh' && tokens[i + 1] === 'pr' && GH_PR_VERBS.has(tokens[i + 2] ?? '')) ||
        (token === 'glab' && tokens[i + 1] === 'mr' && GLAB_MR_VERBS.has(tokens[i + 2] ?? '')),
    )
    if (start === -1) continue

    const call: CliLookup = { cli: tokens[start] === 'gh' ? 'gh' : 'glab', ...(cwd ? { cwd } : {}) }
    const rest = tokens.slice(start + 3)
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i] ?? ''
      if (token === '-R' || token === '--repo') {
        call.repo = rest[++i]
      } else if (token.startsWith('--repo=')) {
        call.repo = token.slice('--repo='.length)
      } else if (call.selector === undefined && isSelector(token)) {
        call.selector = token.replace(/^#/, '')
      }
    }
    calls.push(call)
  }
  return calls
}

/** What a Bash call says about PRs: the ones it names by URL, and the ones still to look up. */
export function prsInBashCall(
  command: string,
  output: string,
  gitPr?: { number: number; url?: string },
): { refs: PrRef[]; lookups: CliLookup[] } {
  const calls = cliCalls(command)
  const refs = uniqueRefs([
    ...findPrUrls(output),
    ...(gitPr?.url ? findPrUrls(gitPr.url) : []),
    // `gh pr view <url>` prints no URL with --json; the command itself names the PR.
    ...(calls.length > 0 ? findPrUrls(command) : []),
  ])
  if (refs.length > 0) return { refs, lookups: [] }

  const lookups: CliLookup[] = calls.map(call => {
    if (call.selector !== undefined || call.cli !== 'gh') return call
    const mention = output.match(PR_MENTION)
    return mention ? { ...call, selector: mention[2], repo: call.repo ?? mention[1] } : call
  })
  if (lookups.length === 0 && gitPr) lookups.push({ cli: 'gh', selector: String(gitPr.number) })
  return { refs, lookups }
}

/** The label a PR goes by on its provider: `#12`, GitLab's `!12`. */
export function prLabel(ref: PrRef): string {
  return `${ref.provider === 'gitlab' ? '!' : '#'}${ref.number}`
}

/** The last segment of the repo path: `repo` for `owner/repo` or `projects/P/repos/repo`. */
export function repoName(ref: PrRef): string {
  return ref.repo.split('/').at(-1) ?? ref.repo
}
