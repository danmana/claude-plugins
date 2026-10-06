# claude-plugins

Claude Code plugins by Dan Manastireanu.

| Plugin | What it does |
| --- | --- |
| [pr-band](plugins/pr-band) | A band above the prompt listing every pull/merge request the session touched, with live state, review and checks |

## pr-band

A band above the prompt listing every pull/merge request the session touched, with live state, review and checks. Claude Code's own footer shows one PR; this shows all of them.

<!-- Screenshot: replace with an image of the band -->

```
● app #12   open   review required   ✓4      Add search
● web !3    draft                     …1 ✓2   Tidy styles
+ 1 merged/closed   ▴ compact
```

**How it works.** Every Bash call the session runs, its subagents' included, is read for PR URLs and for `gh pr` / `glab mr` commands. Each PR gets a row with its state, review and checks, asked of `gh` or `glab` every few minutes while you work.

**Supported sources**

| Provider | Status from |
| --- | --- |
| GitHub, GitHub Enterprise | [`gh`](https://cli.github.com): state, draft, review, checks |
| GitLab, hosted and self-managed | [`glab`](https://gitlab.com/gitlab-org/cli): state, draft, approval, pipeline |
| Bitbucket Cloud and Data Center, Gerrit | link only |

Without a CLI, or when it is logged out, a PR still shows as a plain link.

**Install**

```
/plugin install pr-band --marketplace danmana/claude-plugins
```

More in the [pr-band README](plugins/pr-band/README.md): what it finds, how often it asks, commands and options.

## Install

At a Claude Code prompt in a terminal:

```
/plugin install <plugin> --marketplace danmana/claude-plugins
```

Answer `y` to add the marketplace, then pick a scope.
