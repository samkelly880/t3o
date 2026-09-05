// @effect-diagnostics nodeBuiltinImport:off - deliberately synchronous and
// dependency-free so each seam in an upstream file stays a one-line expression.
// @effect-diagnostics globalConsole:off - the permissions warning fires from
// sync spawn paths that have no Effect logger in scope.
/**
 * T3o gitenv — per-project GitHub token overrides (t3o-34).
 *
 * A hand-edited file at `<stateDir>/gitenv` maps project roots to PATs, one
 * `<project_root>=<pat>` per line (`#` comments and blank lines allowed). When
 * a subprocess that talks to GitHub is spawned for a directory inside a
 * matched project, `{ GH_TOKEN, GITHUB_TOKEN }` is merged over its inherited
 * environment so `gh` — and https git auth through gh's credential helper —
 * act as that project's identity instead of the machine's ambient login.
 *
 * The token only ever rides in a spawn `env` option: never in argv, never in
 * a shell string, never in T3o's own persisted or logged output.
 * `scrubGitenvTokens` exists so persisted process output can also drop the
 * exact configured values, whatever their shape. Note the containment stops at
 * the agent's process boundary: an agent session gets the token in its
 * environment so its own `gh` authenticates, and — exactly as with any ambient
 * credential the process inherits — an agent that deliberately reads its
 * environment can observe it. The guarantee is that T3o never places the token
 * in a prompt, a tool argument, argv, or a log, not that the value is invisible
 * to the agent.
 *
 * Matching is worktree-aware: the calling cwd is resolved to its main
 * repository root by walking up to the nearest `.git` entry and, for linked
 * worktrees (a `.git` *file* pointing at `<main>/.git/worktrees/<name>`),
 * following it back to the main checkout. Board worktrees live under
 * `<T3 home>/worktrees/`, outside the project directory, so a plain prefix
 * match on cwd would miss every board build.
 *
 * The module is intentionally synchronous and dependency-free so each seam in
 * an upstream file stays a one-line expression. `initGitenv` is called from
 * `resolveServerConfig` (the resolver every `t3` server boot goes through:
 * `start`, `serve`, the desktop bootstrap, `vp run dev` — and, through
 * `resolveCliAuthConfig`, `auth`, `connect` and `project`) and from
 * `ServerConfig.make`, which only `pair` still reaches with a hand-built
 * config; it is idempotent on the same path. Before either runs, or when the
 * file is absent, every lookup returns undefined and behavior is exactly
 * stock.
 *
 * GitHub-only for now: no cross-forge token variable exists. A forge-aware
 * variant can later pick the variable per detected remote without changing
 * the file format.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

interface GitenvFileCache {
  readonly mtimeMs: number;
  readonly size: number;
  readonly entries: ReadonlyMap<string, string>;
}

let gitenvPath: string | undefined;
let fileCache: GitenvFileCache | undefined;
let warnedLoosePermissions = false;

/** Shortest value `scrubGitenvTokens` will redact. A real PAT is far longer;
    the floor keeps a placeholder value from mangling unrelated output. */
const MIN_SCRUBBABLE_TOKEN_LENGTH = 16;

export function initGitenv(stateDir: string): void {
  const next = NodePath.join(stateDir, "gitenv");
  if (next === gitenvPath) {
    return;
  }
  gitenvPath = next;
  fileCache = undefined;
  warnedLoosePermissions = false;
}

/** Test seam: forget everything, including the configured file path. */
export function resetGitenvForTesting(): void {
  gitenvPath = undefined;
  fileCache = undefined;
  warnedLoosePermissions = false;
}

function realpathOrSelf(target: string): string {
  try {
    return NodeFS.realpathSync(target);
  } catch {
    return NodePath.resolve(target);
  }
}

/** Expand a leading `~` / `~/` in a gitenv key to the server user's home
    directory, so an entry can be written `~/projects/foo` rather than an
    absolute path. `~otheruser` is left untouched (it needs a passwd lookup and
    is not worth the dependency); such a key stays relative and is skipped. */
function expandTilde(path: string): string {
  if (path === "~") {
    return NodeOS.homedir();
  }
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return NodePath.join(NodeOS.homedir(), path.slice(2));
  }
  return path;
}

function parseGitenv(text: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = expandTilde(line.slice(0, separator).trim());
    const value = line.slice(separator + 1).trim();
    if (key.length === 0 || value.length === 0 || !NodePath.isAbsolute(key)) {
      continue;
    }
    // Keys resolve to their main checkout exactly as lookups do, so an entry
    // keyed by a linked worktree's path still matches.
    entries.set(resolveMainRepositoryRoot(key) ?? realpathOrSelf(key), value);
  }
  return entries;
}

function readEntries(): ReadonlyMap<string, string> | undefined {
  if (gitenvPath === undefined) {
    return undefined;
  }
  let stat: NodeFS.Stats;
  try {
    stat = NodeFS.statSync(gitenvPath);
  } catch {
    fileCache = undefined;
    return undefined;
  }
  if (
    fileCache !== undefined &&
    fileCache.mtimeMs === stat.mtimeMs &&
    fileCache.size === stat.size
  ) {
    return fileCache.entries;
  }
  // oxlint-disable-next-line t3code/no-global-process-runtime -- sync spawn-path module, outside any Effect runtime.
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0 && !warnedLoosePermissions) {
    warnedLoosePermissions = true;
    console.warn(`[t3o] ${gitenvPath} is readable by group/other; chmod 600 is recommended.`);
  }
  let text: string;
  try {
    text = NodeFS.readFileSync(gitenvPath, "utf8");
  } catch {
    return undefined;
  }
  fileCache = { mtimeMs: stat.mtimeMs, size: stat.size, entries: parseGitenv(text) };
  return fileCache.entries;
}

/**
 * Resolve a directory to the root of the main checkout of the repository it
 * sits in. Walks up to the nearest `.git`; a directory means we are in the
 * main checkout, a file is a linked worktree/submodule pointer whose gitdir
 * is followed back to the main root. Returns null outside any repository.
 *
 * Deliberately uncached: a cwd can be a board worktree that does not exist
 * yet, or was just reclaimed, and a remembered answer would pin its
 * replacement at the same path to the wrong identity. The walk is a few
 * `stat`s — nothing next to the process spawn it precedes.
 */
function resolveMainRepositoryRoot(cwd: string): string | null {
  const start = realpathOrSelf(cwd);
  let root: string | null = null;
  let current = start;
  for (;;) {
    const gitEntry = NodePath.join(current, ".git");
    let entryStat: NodeFS.Stats | undefined;
    try {
      entryStat = NodeFS.statSync(gitEntry);
    } catch {
      entryStat = undefined;
    }
    if (entryStat?.isDirectory()) {
      root = current;
      break;
    }
    if (entryStat?.isFile()) {
      root = mainRootFromGitFile(gitEntry, current);
      break;
    }
    const parent = NodePath.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return root;
}

/** `.git` file contents are `gitdir: <path>`; a linked worktree's gitdir is
    `<main>/.git/worktrees/<name>`, from which the main root falls out. Any
    other pointer (submodules) keeps the containing directory as the root. */
function mainRootFromGitFile(gitFile: string, containingDir: string): string {
  let contents: string;
  try {
    contents = NodeFS.readFileSync(gitFile, "utf8");
  } catch {
    return containingDir;
  }
  const match = contents.match(/^gitdir:\s*(.+)\s*$/m);
  if (!match?.[1]) {
    return containingDir;
  }
  const gitdir = NodePath.resolve(containingDir, match[1].trim());
  const worktreeMarker = `${NodePath.sep}.git${NodePath.sep}worktrees${NodePath.sep}`;
  const markerIndex = gitdir.lastIndexOf(worktreeMarker);
  if (markerIndex !== -1) {
    return realpathOrSelf(gitdir.slice(0, markerIndex));
  }
  return containingDir;
}

/**
 * The env fragment for a matched project, or undefined when the file, an
 * entry, or a repository is absent. GitHub-only by design.
 */
export function gitenvTokenEnv(cwd: string | undefined): Record<string, string> | undefined {
  if (cwd === undefined) {
    return undefined;
  }
  const entries = readEntries();
  if (entries === undefined || entries.size === 0) {
    return undefined;
  }
  const root = resolveMainRepositoryRoot(cwd);
  if (root === null) {
    return undefined;
  }
  const token = entries.get(root);
  if (token === undefined) {
    return undefined;
  }
  return { GH_TOKEN: token, GITHUB_TOKEN: token };
}

/**
 * Merge the token fragment over an existing spawn env. Returns the input env
 * untouched (possibly undefined) when nothing matches, so `undefined` keeps
 * meaning "inherit the parent environment" at every call site.
 */
export function withGitenvTokenEnv(
  env: NodeJS.ProcessEnv | undefined,
  cwd: string | undefined,
): NodeJS.ProcessEnv | undefined {
  const tokens = gitenvTokenEnv(cwd);
  if (tokens === undefined) {
    return env;
  }
  return { ...env, ...tokens };
}

/**
 * Drop every configured token value from free text bound for the event log or
 * UI, whatever the token's shape. Complements the published-prefix scrub in
 * `safeProcessOutput`, which cannot know about nonstandard PATs.
 */
export function scrubGitenvTokens(text: string): string {
  const entries = readEntries();
  if (entries === undefined || entries.size === 0) {
    return text;
  }
  let scrubbed = text;
  for (const token of entries.values()) {
    // A usable GitHub token is far longer than this; the floor stops a
    // mistyped or placeholder value from blanket-replacing a common substring
    // across unrelated output.
    if (token.length >= MIN_SCRUBBABLE_TOKEN_LENGTH && scrubbed.includes(token)) {
      scrubbed = scrubbed.split(token).join("***");
    }
  }
  return scrubbed;
}
