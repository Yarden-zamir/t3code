#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - plain Node script.
// Fork: open pingdotgg/t3code pull requests that fork main merged before upstream merged them.
// scripts/fork-adopted-upstream-prs.json lists them in stack order, each with the head that fork
// main holds. See docs/fork/operations.md "Adopted upstream pull requests".
//
//   node scripts/fork-adopted-prs.ts sync    Fork Sync: follow the pull requests, after the upstream main merge
//   node scripts/fork-adopted-prs.ts check   vp run fork:check and Fork CI: check the list against HEAD
//
// It uses only Node built-ins, so Fork Sync runs it before the dependency install.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

export const LIST_PATH = "scripts/fork-adopted-upstream-prs.json";
const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
const HEX_DIGITS = "0123456789abcdef";

export interface AdoptedPullRequest {
  readonly number: number;
  readonly title: string;
  /** The upstream branch of the pull request. Fork Sync follows `refs/pull/<number>/head`. */
  readonly headRef: string;
  /** The full commit of the head that fork main holds. */
  readonly mergedHead: string;
  readonly reason: string;
  /** What the fork changes or keeps out, for example migrations and excluded upstream tests. */
  readonly forkRules?: string;
}

const KEYS = new Set(["number", "title", "headRef", "mergedHead", "reason", "forkRules"]);

function isFullCommit(value: string): boolean {
  return value.length === 40 && [...value].every((character) => HEX_DIGITS.includes(character));
}

function requireText(entry: Record<string, unknown>, key: string, where: string): string {
  const value = entry[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where}: "${key}" must be a non-empty string.`);
  }
  return value;
}

/** Throws on the first entry that does not match the schema of `AdoptedPullRequest`. */
export function parseAdoptedList(text: string): ReadonlyArray<AdoptedPullRequest> {
  const json: unknown = JSON.parse(text);
  if (!Array.isArray(json)) throw new Error(`${LIST_PATH} must hold a JSON array.`);
  const numbers = new Set<number>();
  return json.map((value: unknown, index): AdoptedPullRequest => {
    const where = `${LIST_PATH} entry ${index}`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${where} must be an object.`);
    }
    const entry = value as Record<string, unknown>;
    const unknownKeys = Object.keys(entry).filter((key) => !KEYS.has(key));
    if (unknownKeys.length > 0)
      throw new Error(`${where}: unknown keys ${unknownKeys.join(", ")}.`);
    const number = entry.number;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
      throw new Error(`${where}: "number" must be a positive integer.`);
    }
    if (numbers.has(number)) throw new Error(`${where}: #${number} is listed twice.`);
    numbers.add(number);
    const mergedHead = requireText(entry, "mergedHead", where);
    if (!isFullCommit(mergedHead)) {
      throw new Error(`${where}: "mergedHead" must be a full 40-character lowercase commit.`);
    }
    const forkRules =
      entry.forkRules === undefined ? undefined : requireText(entry, "forkRules", where);
    return {
      number,
      title: requireText(entry, "title", where),
      headRef: requireText(entry, "headRef", where),
      mergedHead,
      reason: requireText(entry, "reason", where),
      ...(forkRules === undefined ? {} : { forkRules }),
    };
  });
}

/**
 * The only format of the list. Its arrays hold objects only, because the formatter puts a short
 * array of strings on one line and a rewrite here would then differ from it.
 */
export function serializeAdoptedList(list: ReadonlyArray<AdoptedPullRequest>): string {
  return `${JSON.stringify(list, null, 2)}\n`;
}

export type UpstreamState =
  | { readonly state: "OPEN" }
  | { readonly state: "MERGED"; readonly mergeCommit: string }
  | { readonly state: "CLOSED" };

/** The git and GitHub calls of `syncAdoptedPullRequests`. The tests replace them. */
export interface SyncIo {
  readonly upstreamState: (number: number) => UpstreamState;
  /** Fetches `refs/pull/<number>/head` from upstream and returns its commit. */
  readonly fetchHead: (number: number) => string;
  readonly isAncestorOfHead: (commit: string) => boolean;
  /**
   * Merges `commit` into HEAD with a merge commit that also writes `listText` to the list.
   * Returns the conflicted paths after it aborts the merge, or nothing when the merge succeeded.
   */
  readonly merge: (commit: string, message: string, listText: string) => ReadonlyArray<string>;
  readonly commitList: (message: string, listText: string) => void;
  readonly log: (line: string) => void;
}

export type SyncResult =
  | { readonly _tag: "Done"; readonly list: ReadonlyArray<AdoptedPullRequest> }
  | { readonly _tag: "Stopped"; readonly reason: string; readonly details: string };

/**
 * Runs after the upstream main merge. In list order, which is the stack order, it drops each pull
 * request that upstream main in HEAD merged, merges the new head of each open one, and stops at a
 * pull request that upstream closed without a merge or whose head conflicts.
 */
export function syncAdoptedPullRequests(
  list: ReadonlyArray<AdoptedPullRequest>,
  io: SyncIo,
): SyncResult {
  let current = list;
  let committedText = serializeAdoptedList(list);
  for (const entry of list) {
    const name = `${UPSTREAM_REPOSITORY}#${entry.number} "${entry.title}"`;
    const upstream = io.upstreamState(entry.number);
    switch (upstream.state) {
      case "CLOSED":
        return {
          _tag: "Stopped",
          reason: `upstream closed adopted pull request #${entry.number} without a merge`,
          details: `${name} is closed and not merged. Fork main still holds its head ${entry.mergedHead}. Decide whether the fork keeps that code. Fork rules: ${entry.forkRules ?? "none"}`,
        };
      case "MERGED":
        // Stacked pull requests can merge into the branch below them first. Their code reaches
        // upstream main later, and the pull requests above them still carry it until then.
        if (!io.isAncestorOfHead(upstream.mergeCommit)) {
          io.log(`${name}: merged, but upstream main in HEAD does not have it yet. Kept.`);
          continue;
        }
        current = current.filter((candidate) => candidate.number !== entry.number);
        io.log(
          `${name}: upstream main has it, dropped from the list. Undo its fork rules where upstream main now covers them: ${entry.forkRules ?? "none"}`,
        );
        continue;
      case "OPEN": {
        const head = io.fetchHead(entry.number);
        if (head === entry.mergedHead) {
          io.log(`${name}: unchanged at ${head}.`);
          continue;
        }
        current = current.map((candidate) =>
          candidate.number === entry.number ? { ...candidate, mergedHead: head } : candidate,
        );
        if (io.isAncestorOfHead(head)) {
          io.log(`${name}: HEAD already has the new head ${head}.`);
          continue;
        }
        const listText = serializeAdoptedList(current);
        const conflicts = io.merge(
          head,
          `chore(sync): merge ${UPSTREAM_REPOSITORY}#${entry.number} at ${head.slice(0, 10)}`,
          listText,
        );
        if (conflicts.length > 0) {
          return {
            _tag: "Stopped",
            reason: `merge conflict in adopted pull request #${entry.number}`,
            details: `The new head ${head} of ${name} conflicts with fork main in:\n${conflicts.join("\n")}`,
          };
        }
        committedText = listText;
        io.log(`${name}: merged the new head ${head}.`);
      }
    }
  }
  const listText = serializeAdoptedList(current);
  if (listText !== committedText) {
    io.commitList("chore(sync): update the adopted upstream pull requests", listText);
  }
  return { _tag: "Done", list: current };
}

/** Each listed pull request whose squash commit, `<title> (#<number>)`, HEAD already holds. */
export function mergedUpstreamProblems(
  list: ReadonlyArray<AdoptedPullRequest>,
  headSubjects: ReadonlyArray<string>,
): ReadonlyArray<string> {
  // Limit: upstream squash merges end their subject with ` (#<number>)`. If upstream changes that
  // format, this check finds nothing, and Fork Sync still drops merged pull requests through gh.
  const subjects = new Set(
    headSubjects.flatMap((subject) => {
      const start = subject.lastIndexOf(" (#");
      return start === -1 || !subject.endsWith(")") ? [] : [subject.slice(start + 3, -1)];
    }),
  );
  return list.flatMap((entry) =>
    subjects.has(String(entry.number))
      ? [
          `#${entry.number}: HEAD holds its upstream squash commit. Fork Sync drops merged pull requests; remove the entry.`,
        ]
      : [],
  );
}

function git(...args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, { encoding: "utf8" }).trim();
}

function gitSucceeds(...args: ReadonlyArray<string>): boolean {
  return NodeChildProcess.spawnSync("git", args, { stdio: "ignore" }).status === 0;
}

function writeList(listText: string): void {
  NodeFS.writeFileSync(LIST_PATH, listText);
  git("add", "--", LIST_PATH);
}

const realIo: SyncIo = {
  upstreamState: (number) => {
    const json = JSON.parse(
      NodeChildProcess.execFileSync(
        "gh",
        [
          "pr",
          "view",
          String(number),
          "--repo",
          UPSTREAM_REPOSITORY,
          "--json",
          "state,mergeCommit",
        ],
        { encoding: "utf8" },
      ),
    ) as { readonly state?: unknown; readonly mergeCommit?: { readonly oid?: unknown } | null };
    if (json.state === "OPEN" || json.state === "CLOSED") return { state: json.state };
    const mergeCommit = json.mergeCommit?.oid;
    if (json.state === "MERGED" && typeof mergeCommit === "string") {
      return { state: "MERGED", mergeCommit };
    }
    throw new Error(
      `Unexpected state of ${UPSTREAM_REPOSITORY}#${number}: ${JSON.stringify(json)}`,
    );
  },
  fetchHead: (number) => {
    const ref = `refs/remotes/upstream/pr-${number}`;
    git(
      "fetch",
      "--no-tags",
      `https://github.com/${UPSTREAM_REPOSITORY}.git`,
      `+refs/pull/${number}/head:${ref}`,
    );
    return git("rev-parse", `${ref}^{commit}`);
  },
  // Exit code 1 is "not an ancestor", 128 is "unknown commit". Both mean HEAD lacks it.
  isAncestorOfHead: (commit) => gitSucceeds("merge-base", "--is-ancestor", commit, "HEAD"),
  merge: (commit, message, listText) => {
    const result = NodeChildProcess.spawnSync("git", ["merge", "--no-ff", "--no-commit", commit], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      const conflicts = git("diff", "--name-only", "--diff-filter=U");
      git("merge", "--abort");
      if (conflicts === "")
        throw new Error(`git merge ${commit} failed:\n${result.stdout}${result.stderr}`);
      return conflicts.split("\n");
    }
    writeList(listText);
    git("commit", "--no-edit", "--quiet", "-m", message);
    return [];
  },
  commitList: (message, listText) => {
    writeList(listText);
    git("commit", "--quiet", "-m", message);
  },
  log: (line) => console.log(line),
};

function sync(): void {
  const list = parseAdoptedList(NodeFS.readFileSync(LIST_PATH, "utf8"));
  const result = syncAdoptedPullRequests(list, realIo);
  if (result._tag === "Done") {
    // A GitHub Actions annotation, so that the run summary shows the follow-up of each drop.
    const kept = new Set(result.list.map((entry) => entry.number));
    for (const entry of list) {
      if (!kept.has(entry.number) && entry.forkRules !== undefined) {
        console.log(
          `::warning title=Upstream merged #${entry.number}::Undo its fork rules where upstream main now covers them: ${entry.forkRules}`,
        );
      }
    }
    console.log(`${result.list.length} adopted upstream pull requests.`);
    return;
  }
  console.error(`${result.reason}\n${result.details}`);
  // Fork Sync names the reason in its issue and in the call to the repair agent.
  if (process.env.GITHUB_OUTPUT)
    NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `reason=${result.reason}\n`);
  process.exit(1);
}

function check(): void {
  const text = NodeFS.readFileSync(LIST_PATH, "utf8");
  const list = parseAdoptedList(text);
  const problems: Array<string> = [];
  if (text !== serializeAdoptedList(list)) {
    problems.push(
      `${LIST_PATH} is not in the format that Fork Sync writes: JSON.stringify(list, null, 2).`,
    );
  }
  // Offline: it reads only local commits. A shallow clone lacks them, so Fork CI fetches them first.
  if (git("rev-parse", "--is-shallow-repository") === "true") {
    console.log(`Shallow clone: checked only the schema of ${LIST_PATH}.`);
  } else {
    for (const entry of list) {
      if (!gitSucceeds("merge-base", "--is-ancestor", entry.mergedHead, "HEAD")) {
        problems.push(`#${entry.number}: HEAD does not hold its head ${entry.mergedHead}.`);
      }
    }
    problems.push(...mergedUpstreamProblems(list, git("log", "--format=%s", "HEAD").split("\n")));
  }
  if (problems.length > 0) {
    console.error(`${LIST_PATH}:`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log(
    `${list.length} adopted upstream pull requests. HEAD holds each head and no upstream squash commit of them.`,
  );
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "sync") sync();
  else if (command === "check") check();
  else {
    console.error("Usage: node scripts/fork-adopted-prs.ts sync|check");
    process.exit(2);
  }
}
