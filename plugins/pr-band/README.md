# pr-band

A band above the Claude Code prompt that lists every pull/merge request the session has touched, with live state, review and checks.

Claude Code's own footer shows one PR per session. `pr-band` shows all of them.

<!-- Screenshots: full view, compact view, hover -->

```
● app #12   open   review required   ✓4      Add search
● web !3    draft                     …1 ✓2   Tidy styles
+ 1 merged/closed   ▴ compact
```

Compact view, one line, each number a link colored by its state:

```
#12 !3 +1 merged/closed ▾ details
```

Hover a number to see its repo, state, review, checks and title.

## Install

At a Claude Code prompt in a terminal:

```
/plugin install pr-band --marketplace danmana/claude-plugins
```

Answer `y` to add the marketplace, then pick a scope.

`pr-band` is a *mod*: a plugin of function hooks. That plugin API is early access and may change between Claude Code releases, so an update can break it until the mod catches up. Built and tested on Claude Code 2.1.291.

Once it is in place you may want to turn off the built-in footer PR in `/config` → *Show PR status footer*.

## What it finds

Every Bash call the session runs, its subagents' included, is read for:

- pull/merge request URLs in the command's output: GitHub and GitHub Enterprise (`/pull/N`), GitLab hosted and self-managed (`/-/merge_requests/N`), Bitbucket Cloud and Data Center (`/pull-requests/N`), and Gerrit on `*-review.googlesource.com`. This covers the `remote:` lines `git push` prints;
- URLs in a `gh pr …` / `glab mr …` command itself (`gh pr view <url> --json state` prints none);
- PRs named only by number, or the current branch's (`gh pr merge 42`, `glab mr note 7`, `gh pr checks`): when the CLI is available it is asked for the URL;
- the PR Claude Code itself reports for a git or `gh` command.

When the plugin loads into a session that is already running, it reads the conversation so far the same way. Subagents that have already finished cannot be read; their reports are scanned for PR URLs instead. A session compacted before the plugin was installed has lost what was before the compaction.

The list is kept per session, so it survives `/compact`, resuming the session and plugin reloads.

## Status

Status comes from the provider's CLI, when it is installed and logged in:

| Provider | CLI | Shows |
| --- | --- | --- |
| GitHub, GitHub Enterprise | [`gh`](https://cli.github.com) | state, draft, review decision, checks |
| GitLab | [`glab`](https://gitlab.com/gitlab-org/cli) | state, draft, approval needed, pipeline |
| Bitbucket, Gerrit | none | link only |

Neither CLI is required. Without one, or when it is logged out or fails, the PR still shows as a plain link with *no status*.

### How often it asks

Each ask is one CLI call, one API request. `pr-band` keeps them few:

- An open PR is asked at most once per **refresh interval**, 5 minutes by default (the `refreshMinutes` option, 1 to 60). Merged and closed PRs are not asked again.
- **Idle sessions ask nothing.** After 15 minutes without a prompt, a turn or a tool call, the timer stops; the next prompt brings stale statuses up to date at once.
- A command that names a PR (`gh pr merge 42`) asks about that PR right away, and only that one.
- A press on any of the band's buttons, `↻` among them, brings the open PRs up to date.
- Statuses are shared between sessions: a PR another session asked about within the interval is not asked again.

With 5 open PRs that is about 60 requests an hour in a session in use, and none in one left open overnight.

Colors: green open, grey draft, purple merged, red closed or a failing check.

## Commands

| Command | Does |
| --- | --- |
| `/pr-band` or `/pr-band refresh` | re-reads the conversation and brings every open PR's status up to date |
| `/pr-band compact` | switches between the full and the compact view (remembered across sessions) |
| `/pr-band merged` | shows or hides merged and closed PRs |
| `/pr-band clear` | empties the list for this session |
| `/pr-band why` | asks every PR's status again and says what each CLI call came to, for a PR showing *no status* |

The band's own buttons do the same for the view, for merged PRs and for refreshing (`↻`). `[-]` at the right collapses the whole band; that one belongs to Claude Code.

## Options

| Option | Default | |
| --- | --- | --- |
| `refreshMinutes` | 5 | how often an open PR's status is asked again while the session is in use, 1 to 60 |

Set it when installing, or later in `/config`.

## Development

Load it from a checkout for one session:

```
claude --plugin-dir ./plugins/pr-band
```

Claude Code lays the API's types into `.claude-plugin/types/` when it loads the plugin; after that:

```
claude plugin validate ./plugins/pr-band
claude plugin test ./plugins/pr-band
npx tsc -p ./plugins/pr-band
```
