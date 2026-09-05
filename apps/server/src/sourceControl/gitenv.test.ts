// @effect-diagnostics nodeBuiltinImport:off - exercises the deliberately
// synchronous gitenv module against real temp directories.
// @effect-diagnostics globalDate:off - forces a distinct file mtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  gitenvTokenEnv,
  initGitenv,
  resetGitenvForTesting,
  scrubGitenvTokens,
  withGitenvTokenEnv,
} from "./gitenv.ts";

const TOKEN = "ghp_testTokenValue0123456789abcdef";

interface Fixture {
  readonly stateDir: string;
  readonly projectRoot: string;
  readonly nestedDir: string;
  readonly worktreeDir: string;
  readonly outsideDir: string;
}

/** A main checkout, a linked worktree pointing back at it (as `git worktree
    add` lays it out), a directory outside any repository, and a state dir. */
function makeFixture(): Fixture {
  const base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "gitenv-")));
  const stateDir = NodePath.join(base, "state");
  const projectRoot = NodePath.join(base, "project");
  const nestedDir = NodePath.join(projectRoot, "src", "deep");
  const worktreeGitDir = NodePath.join(projectRoot, ".git", "worktrees", "card-1");
  const worktreeDir = NodePath.join(base, "worktrees", "card-1");
  const outsideDir = NodePath.join(base, "elsewhere");
  for (const dir of [stateDir, nestedDir, worktreeGitDir, worktreeDir, outsideDir]) {
    NodeFS.mkdirSync(dir, { recursive: true });
  }
  NodeFS.writeFileSync(NodePath.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
  return { stateDir, projectRoot, nestedDir, worktreeDir, outsideDir };
}

function writeGitenv(fixture: Fixture, contents: string): string {
  const filePath = NodePath.join(fixture.stateDir, "gitenv");
  NodeFS.writeFileSync(filePath, contents, { mode: 0o600 });
  initGitenv(fixture.stateDir);
  return filePath;
}

afterEach(() => {
  resetGitenvForTesting();
});

describe("gitenv", () => {
  it("returns undefined before initGitenv and when the file is absent", () => {
    const fixture = makeFixture();
    expect(gitenvTokenEnv(fixture.projectRoot)).toBeUndefined();
    initGitenv(fixture.stateDir);
    expect(gitenvTokenEnv(fixture.projectRoot)).toBeUndefined();
  });

  it("ignores comments, blank lines, and malformed entries", () => {
    const fixture = makeFixture();
    writeGitenv(
      fixture,
      [
        "# a comment",
        "",
        "not-an-entry",
        "=missing-key",
        `${fixture.projectRoot}=`,
        `relative/path=${TOKEN}`,
        `${fixture.projectRoot}=${TOKEN}`,
      ].join("\n"),
    );
    expect(gitenvTokenEnv(fixture.projectRoot)).toEqual({
      GH_TOKEN: TOKEN,
      GITHUB_TOKEN: TOKEN,
    });
    expect(gitenvTokenEnv(fixture.outsideDir)).toBeUndefined();
  });

  it("matches any directory inside the main checkout", () => {
    const fixture = makeFixture();
    writeGitenv(fixture, `${fixture.projectRoot}=${TOKEN}\n`);
    expect(gitenvTokenEnv(fixture.nestedDir)).toEqual({
      GH_TOKEN: TOKEN,
      GITHUB_TOKEN: TOKEN,
    });
  });

  it("resolves a linked worktree back to the project entry", () => {
    const fixture = makeFixture();
    writeGitenv(fixture, `${fixture.projectRoot}=${TOKEN}\n`);
    expect(gitenvTokenEnv(fixture.worktreeDir)).toEqual({
      GH_TOKEN: TOKEN,
      GITHUB_TOKEN: TOKEN,
    });
  });

  it("wins over an ambient GH_TOKEN but leaves unmatched env untouched", () => {
    const fixture = makeFixture();
    writeGitenv(fixture, `${fixture.projectRoot}=${TOKEN}\n`);
    const ambient = { GH_TOKEN: "ambient", PATH: "/usr/bin" };
    expect(withGitenvTokenEnv(ambient, fixture.projectRoot)).toEqual({
      GH_TOKEN: TOKEN,
      GITHUB_TOKEN: TOKEN,
      PATH: "/usr/bin",
    });
    expect(withGitenvTokenEnv(ambient, fixture.outsideDir)).toBe(ambient);
    expect(withGitenvTokenEnv(undefined, fixture.outsideDir)).toBeUndefined();
  });

  it("picks up edits without re-initialization", () => {
    const fixture = makeFixture();
    const filePath = writeGitenv(fixture, `${fixture.projectRoot}=${TOKEN}\n`);
    expect(gitenvTokenEnv(fixture.projectRoot)?.GH_TOKEN).toBe(TOKEN);

    NodeFS.writeFileSync(filePath, `${fixture.projectRoot}=${TOKEN}-rotated\n`);
    // mtime can land in the same clock tick as the first write; force it.
    const later = new Date(Date.now() + 2_000);
    NodeFS.utimesSync(filePath, later, later);
    expect(gitenvTokenEnv(fixture.projectRoot)?.GH_TOKEN).toBe(`${TOKEN}-rotated`);
  });

  it("scrubs configured token values from free text", () => {
    const fixture = makeFixture();
    writeGitenv(fixture, `${fixture.projectRoot}=${TOKEN}\n`);
    expect(scrubGitenvTokens(`remote said ${TOKEN} twice: ${TOKEN}`)).toBe(
      "remote said *** twice: ***",
    );
    expect(scrubGitenvTokens("nothing sensitive")).toBe("nothing sensitive");
  });

  it("does not scrub a short/placeholder configured value", () => {
    const fixture = makeFixture();
    writeGitenv(fixture, `${fixture.projectRoot}=todo\n`);
    expect(scrubGitenvTokens("the value todo appears in ordinary text")).toBe(
      "the value todo appears in ordinary text",
    );
  });
  it("matches when the key is a linked worktree's path", () => {
    const fixture = makeFixture();
    writeGitenv(fixture, `${fixture.worktreeDir}=${TOKEN}\n`);
    expect(gitenvTokenEnv(fixture.nestedDir)?.GH_TOKEN).toBe(TOKEN);
    expect(gitenvTokenEnv(fixture.worktreeDir)?.GH_TOKEN).toBe(TOKEN);
  });

  it("does not remember a worktree path that did not exist yet", () => {
    const fixture = makeFixture();
    writeGitenv(fixture, `${fixture.projectRoot}=${TOKEN}\n`);
    const futureWorktree = NodePath.join(NodePath.dirname(fixture.worktreeDir), "card-2");
    expect(gitenvTokenEnv(futureWorktree)).toBeUndefined();
    NodeFS.mkdirSync(futureWorktree, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(futureWorktree, ".git"),
      `gitdir: ${NodePath.join(fixture.projectRoot, ".git", "worktrees", "card-2")}\n`,
    );
    expect(gitenvTokenEnv(futureWorktree)?.GH_TOKEN).toBe(TOKEN);
  });
  it("expands a leading ~ in a key to the home directory", () => {
    const fixture = makeFixture();
    const savedHome = process.env.HOME;
    try {
      // os.homedir() honours $HOME on POSIX, so point it at the fixture base
      // (the parent of projectRoot) and key the entry with a tilde.
      process.env.HOME = NodePath.dirname(fixture.projectRoot);
      writeGitenv(fixture, `~/project=${TOKEN}\n`);
      expect(gitenvTokenEnv(fixture.nestedDir)?.GH_TOKEN).toBe(TOKEN);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
});
