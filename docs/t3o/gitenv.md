# gitenv — per-project GitHub token overrides

`t3o-34`. Lets a specific project authenticate to GitHub as a different identity than the
machine's ambient `gh` login. Upstream has no mechanism for this: every `gh` call inherits the
server's environment verbatim, so auth is whatever `~/.config/gh/hosts.yml` (or an ambient
`GH_TOKEN`) says.

> User-facing setup lives in [`docs/user/source-control.md`](../user/source-control.md) under
> "Using a different GitHub identity for specific projects". This page is the contributor-facing
> "how it works".

## The file

One hand-edited file at `<stateDir>/gitenv`:

- production: `~/.t3/userdata/gitenv`
- `vp run dev` against `~/.t3`: `~/.t3/dev/gitenv`
- a dev worktree: `<worktree>/.t3/userdata/gitenv`

Format, one entry per line — the key is the project's main checkout, given as an absolute path or a
`~`/`~/`-prefixed path (expanded against the server user's home; `~otheruser` is not expanded):

```
# comments and blank lines are fine
/home/me/projects/client-x=github_pat_XXXX
~/projects/client-y=github_pat_YYYY
```

`chmod 600` it; the server logs a one-line warning (never the value) if group/other can read it.
The file is **loaded lazily, on demand** — nothing reads it at boot (server start only points the
module at `<stateDir>/gitenv`), and `readEntries()` runs on every GitHub-touching spawn, re-reading
whenever the file's mtime or size changes. So you can create _or_ edit the file while the server is
running and the next action picks it up; no restart. Malformed lines (no `=`, empty value, a key
that is neither absolute nor `~`-rooted) are silently skipped.

There is no username component: `GH_TOKEN` alone authenticates `gh`, and https git pushes work
through gh's credential helper, which honors the same variable. SSH remotes ignore tokens entirely.

## What it affects

When a subprocess is spawned for a directory that resolves into a matched project,
`{ GH_TOKEN, GITHUB_TOKEN }` is merged over its inherited environment. The token rides only in the
spawn env — never in argv, never in a shell string, never in T3o's own persisted or logged output —
and persisted forge output is scrubbed of the exact configured values on top of the usual
token-shape scrub.

The containment stops at the agent's process boundary. To make an agent's own `gh pr create`
authenticate as the project, the token has to be in that agent process's environment — and, exactly
as with any ambient credential the process inherits, an agent that deliberately reads its own
environment (`printenv`, a tool that dumps env) can observe it. The guarantee is that T3o never puts
the token in a prompt, a tool argument, argv, or a log; it is not that the value is invisible to the
agent. If that exposure is unacceptable for a given project, don't give its agents an entry — the
server's own `gh`/`git` calls still get the override.

Covered surfaces:

- **The server's own `gh` calls** — discovery/auth probes, PR find and merge (the board's merge
  path included).
- **The server's own `git` fetch/push** — matters only for https remotes using gh's credential
  helper.
- **Agent sessions** for Claude, Codex, Cursor and Grok — the agent's `gh pr create` in a board
  worktree acts as the project's identity. OpenCode is not covered: its server process is not
  spawned per-project, so there is no per-project env seam.

Not covered, by design: interactive terminals (ambient auth stands), GitLab / Bitbucket / Azure
(no cross-forge token variable exists; the reader can grow a forge-aware variant later without
changing the file format).

## Matching is worktree-aware

The calling directory is resolved to its **main repository root** (following a linked worktree's
`.git` file back to the main checkout) and that root is matched exactly against the file's keys.
Board worktrees live under `<T3 home>/worktrees/`, outside the project directory, so key the entry
by the project root — one line covers the project and every worktree cut from it. A linked-worktree
path works as a key too: keys are resolved to their main checkout exactly as lookups are.

## Implementation

All logic lives in `apps/server/src/sourceControl/gitenv.ts` (T3o-owned, deliberately synchronous
and dependency-free so each seam stays a one-line expression). The 15 seams across 7 upstream
files are listed in the [seam inventory](./seams.md) census. `initGitenv` is wired into
`resolveServerConfig` — the resolver every `t3` server boot goes through (`start`, `serve`, the
desktop bootstrap, `vp run dev`) — and into `ServerConfig.make`, which only `pair` still reaches with a hand-built config; it is
idempotent on the same path. Before it runs, or when the file is absent, behavior is exactly stock.
A focused test in `cli/config.test.ts` proves the boot-path wiring, not just the module.
