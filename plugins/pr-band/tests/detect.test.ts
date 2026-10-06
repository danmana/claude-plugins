import { describe, expect, test } from 'claude-code/testing'

import { cliCalls, findPrUrls, prLabel, prsInBashCall, repoName } from '../hooks/detect'
import { countChecks, lookupCommand, normalize, parseLookup, parseStatus, statusCommand } from '../hooks/status'

describe('findPrUrls', () => {
  test('finds each provider and leaves off what follows the number', () => {
    const text = [
      'Created https://github.com/acme/app/pull/12/files',
      'see https://ghe.example.com/team/tool/pull/7#discussion_r1',
      'remote: View merge request for fix:',
      'remote:   https://gitlab.com/acme/platform/api/-/merge_requests/34',
      'https://bitbucket.org/acme/site/pull-requests/5',
      'https://git.example.com/projects/OPS/repos/infra/pull-requests/8/overview',
      'https://example-review.googlesource.com/c/tools/build/+/123456',
    ].join('\n')
    expect(findPrUrls(text).map(ref => [ref.provider, ref.repo, ref.number, ref.url])).toEqual([
      ['github', 'acme/app', 12, 'https://github.com/acme/app/pull/12'],
      ['github', 'team/tool', 7, 'https://ghe.example.com/team/tool/pull/7'],
      ['gitlab', 'acme/platform/api', 34, 'https://gitlab.com/acme/platform/api/-/merge_requests/34'],
      ['bitbucket', 'acme/site', 5, 'https://bitbucket.org/acme/site/pull-requests/5'],
      ['bitbucket', 'projects/OPS/repos/infra', 8, 'https://git.example.com/projects/OPS/repos/infra/pull-requests/8'],
      ['gerrit', 'tools/build', 123456, 'https://example-review.googlesource.com/c/tools/build/+/123456'],
    ])
  })

  test('ignores the links git push prints for opening a new PR, and repeats', () => {
    const text = [
      'remote: Create a pull request for fix on GitHub by visiting:',
      'remote:      https://github.com/acme/app/pull/new/fix',
      'remote: https://gitlab.com/acme/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=fix',
      'https://github.com/acme/app/pull/3 and again https://github.com/acme/app/pull/3',
    ].join('\n')
    expect(findPrUrls(text).map(ref => ref.number)).toEqual([3])
  })

  test('labels and repo names', () => {
    const [github, gitlab, bitbucket] = findPrUrls(
      'https://github.com/acme/app/pull/1 https://gitlab.com/a/b/c/-/merge_requests/2 https://h.example.com/projects/P/repos/r/pull-requests/3',
    )
    expect([github, gitlab, bitbucket].map(ref => (ref ? `${repoName(ref)} ${prLabel(ref)}` : ''))).toEqual([
      'app #1',
      'c !2',
      'r #3',
    ])
  })
})

describe('cliCalls', () => {
  test('reads number, repo and directory', () => {
    expect(cliCalls('cd ../app && gh pr merge 42 --squash --repo acme/app')).toEqual([
      { cli: 'gh', cwd: '../app', selector: '42', repo: 'acme/app' },
    ])
    expect(cliCalls('glab mr note 7 -R acme/app -m "ship it 3"')).toEqual([{ cli: 'glab', selector: '7', repo: 'acme/app' }])
    expect(cliCalls('gh pr view --json title')).toEqual([{ cli: 'gh' }])
  })

  test('skips listing and creating', () => {
    expect(cliCalls('gh pr list && gh pr create --fill && glab mr list')).toEqual([])
  })
})

describe('prsInBashCall', () => {
  test('a URL in the output wins over a lookup', () => {
    const found = prsInBashCall('gh pr create --fill', 'https://github.com/acme/app/pull/9\n')
    expect(found.refs.map(ref => ref.number)).toEqual([9])
    expect(found.lookups).toEqual([])
  })

  test('a PR named only by number is looked up', () => {
    expect(prsInBashCall('gh pr merge 42 --squash', '✓ Squashed and merged pull request acme/app#42 (Fix)').lookups).toEqual([
      { cli: 'gh', selector: '42' },
    ])
    expect(prsInBashCall('gh pr merge --squash', '✓ Merged pull request acme/app#42 (Fix)').lookups).toEqual([
      { cli: 'gh', selector: '42', repo: 'acme/app' },
    ])
  })

  test('the command names the PR when the output does not', () => {
    const found = prsInBashCall('gh pr view https://github.com/acme/app/pull/5 --json state', '{"state":"OPEN"}')
    expect(found.refs.map(ref => ref.url)).toEqual(['https://github.com/acme/app/pull/5'])
  })

  test('the git operation Claude Code reported', () => {
    expect(prsInBashCall('git push', '', { number: 4, url: 'https://github.com/acme/app/pull/4' }).refs.map(r => r.number)).toEqual([4])
    expect(prsInBashCall('git push', '', { number: 4 }).lookups).toEqual([{ cli: 'gh', selector: '4' }])
  })

  test('an unrelated command finds nothing', () => {
    expect(prsInBashCall('git log --oneline', 'abc123 Merge pull request #12 from acme/fix')).toEqual({ refs: [], lookups: [] })
  })
})

describe('status', () => {
  const [github, gitlab, bitbucket] = findPrUrls(
    'https://github.com/acme/app/pull/1 https://gitlab.com/acme/app/-/merge_requests/2 https://bitbucket.org/acme/app/pull-requests/3',
  )

  test('commands per provider', () => {
    expect(github && statusCommand(github)?.slice(0, 4)).toEqual(['gh', 'pr', 'view', 'https://github.com/acme/app/pull/1'])
    expect(gitlab && statusCommand(gitlab)).toEqual(['glab', 'mr', 'view', '2', '-R', 'https://gitlab.com/acme/app', '-F', 'json'])
    expect(bitbucket && statusCommand(bitbucket)).toBeNull()
    expect(lookupCommand({ cli: 'glab', selector: '7', repo: 'acme/app' })).toEqual(['glab', 'mr', 'view', '7', '-R', 'acme/app', '-F', 'json'])
    expect(parseLookup('glab', '{"web_url":"https://gitlab.com/acme/app/-/merge_requests/7"}')).toBe('https://gitlab.com/acme/app/-/merge_requests/7')
  })

  test('gh output', () => {
    const stdout = JSON.stringify({
      title: 'Add search',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: 'REVIEW_REQUIRED',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }, { status: 'IN_PROGRESS', conclusion: '' }],
    })
    expect(github && parseStatus(github, stdout)).toEqual({
      title: 'Add search',
      state: 'open',
      review: 'review_required',
      checks: { passed: 1, failed: 1, pending: 1 },
    })
  })

  test('glab output', () => {
    const stdout = JSON.stringify({ title: 'Fix login', state: 'opened', draft: true, detailed_merge_status: 'not_approved', head_pipeline: { status: 'running' } })
    expect(gitlab && parseStatus(gitlab, stdout)).toEqual({
      title: 'Fix login',
      state: 'draft',
      review: 'review_required',
      checks: { passed: 0, failed: 0, pending: 1 },
    })
  })

  test('entries an older version left in state are rebuilt from their URL', () => {
    const status = { title: 'Add search', state: 'open', review: null, checks: null }
    expect(
      normalize([
        { url: 'https://github.com/acme/app/pull/1', repo: 'acme/app', number: 1, title: 'x', state: 'OPEN', passed: 0 },
        { url: 'https://gitlab.com/acme/app/-/merge_requests/2', status },
        { url: 'https://github.com/acme/app/pull/3', status: { title: 'y', state: 'OPEN' } },
        { url: 'not a pr' },
        null,
      ]),
    ).toEqual([
      { url: 'https://github.com/acme/app/pull/1', repo: 'acme/app', number: 1, provider: 'github', status: null },
      { url: 'https://gitlab.com/acme/app/-/merge_requests/2', repo: 'acme/app', number: 2, provider: 'gitlab', status },
      { url: 'https://github.com/acme/app/pull/3', repo: 'acme/app', number: 3, provider: 'github', status: null },
    ])
  })

  test('anything unreadable is no status', () => {
    expect(github && parseStatus(github, 'not json')).toBeNull()
    expect(github && parseStatus(github, '{"state":"SOMETHING"}')).toBeNull()
    expect(countChecks(['success', 'canceled', 'manual'])).toEqual({ passed: 1, failed: 1, pending: 1 })
  })
})
