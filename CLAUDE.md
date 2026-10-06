# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code plugin marketplace (`danmana/claude-plugins`). `.claude-plugin/marketplace.json` lists the plugins, and each plugin lives in `plugins/<name>/` with its own `.claude-plugin/plugin.json`. So far the only plugin is `pr-band`.

`pr-band` is a **mod**: a plugin of function hooks, written in TypeScript/TSX against the early-access `claude-code` hooks API. **Load the `plugin-authoring` skill before you write, change or debug a mod.** It is the reference for that API: events, `$` engine methods, atoms, `ui.render`, and the `claude-code/testing` harness. Its API may change between Claude Code releases, and the README records the version the mod was built and tested on.

## Commands

Run these from the repo root. Swap in another plugin's path as needed.

```
claude --plugin-dir ./plugins/pr-band     # load the mod from the checkout for one session
claude plugin validate ./plugins/pr-band
claude plugin test ./plugins/pr-band      # runs tests/*.test.ts(x)
npx tsc -p ./plugins/pr-band              # type-check
```

There is no `package.json` or `node_modules`. When Claude Code loads a mod, it writes the API's types into `plugins/<name>/.claude-plugin/types/`, which is gitignored. The plugin's `tsconfig.json` extends that folder's config, so `tsc` only works after the mod has been loaded once, by `--plugin-dir` or by `plugin test`.

## pr-band architecture

- `hooks/hooks.json` names the entry module, `register.tsx`. Its exported `register(on, options)` wires every hook. `options` holds the `userConfig` values from `plugin.json` (`refreshMinutes`).
- `hooks/detect.ts` is pure parsing and does no I/O. It finds PR URLs (GitHub/GHE, GitLab, Bitbucket, Gerrit) in text, and finds `gh pr` / `glab mr` commands that name a PR only by number or branch. Those become `CliLookup`s, which are resolved to URLs by asking the CLI.
- `hooks/status.ts` builds the `gh`/`glab` command lines and parses their JSON into `PrStatus`. `normalize`/`readStatus` rebuild state written by older versions, because state outlives a reload.
- `hooks/register.tsx` holds all the stateful behaviour:
  - **Sources of PRs:** the `tool.call` hook for `Bash` (subagent calls included), plus a catch-up at `session.start` that scans `$.session.messages()` and subagents' reports.
  - **State:** `atom`s (`prs`, `showClosed`, `isCompact`) drive the UI. `$.store` persists the per-session PR list (`sessions`), the view choice (`isCompact`), and statuses keyed `status:<url>`. Statuses are shared across sessions, so a status that is still fresh is reused instead of asked again.
  - **Refresh policy:** a 60 s tick refreshes statuses older than `refreshMinutes`, and stops after 15 min with no activity. Bash calls and presses on the band refresh right away. Merged/closed PRs are never asked again. All CLI calls go through `runCli`, which never throws and backs off a CLI that cannot start.
  - **UI:** `ui.render` on the `AbovePrompt` component, with a full view (one row per PR) and a compact view (one line, details shown on hover).
  - `/pr-band [refresh|merged|compact|clear|why]` is registered at `session.start` and handled in `command.run`.
- `types/index.d.ts` holds the shared types and adds the plugin's atoms to `PluginState` in `claude-code`.
- In `tests/`, `detect.test.ts` unit-tests the parsers. `band.test.tsx` drives the whole mod through the testing harness. Its `standIn()` stubs engine events, `mock.store`/`mock.clock` give storage and time, `process.run` stands in for `gh`/`glab`, and `$.ui.mount` renders the band.

## Conventions

- When you change a plugin's behaviour, bump its `version` in `.claude-plugin/plugin.json` so installed copies update.
- User-facing docs live in each plugin's own README. The root README stays short: the plugin table, the install command, and links to each plugin's README.
