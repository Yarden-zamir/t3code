import { assert, it } from "@effect/vitest";

import {
  type AdoptedPullRequest,
  mergedUpstreamProblems,
  parseAdoptedList,
  serializeAdoptedList,
  type SyncIo,
  syncAdoptedPullRequests,
  type UpstreamState,
} from "./fork-adopted-prs.ts";

const commit = (digit: string) => digit.repeat(40);

const entry = (number: number, mergedHead: string): AdoptedPullRequest => ({
  number,
  title: `pull request ${number}`,
  headRef: `stack/${number}`,
  mergedHead,
  reason: "stack",
});

const stack = [entry(1, commit("a")), entry(2, commit("b")), entry(3, commit("c"))] as const;

interface FakeUpstream {
  readonly states?: Readonly<Record<number, UpstreamState>>;
  readonly heads?: Readonly<Record<number, string>>;
  readonly inHead?: ReadonlyArray<string>;
  readonly conflicts?: Readonly<Record<string, ReadonlyArray<string>>>;
}

/** Records the merges and the list commits. Unlisted pull requests are open at their listed head. */
function fakeIo(upstream: FakeUpstream) {
  const merges: Array<{
    readonly commit: string;
    readonly list: ReadonlyArray<AdoptedPullRequest>;
  }> = [];
  const listCommits: Array<ReadonlyArray<AdoptedPullRequest>> = [];
  const io: SyncIo = {
    upstreamState: (number) => upstream.states?.[number] ?? { state: "OPEN" },
    fetchHead: (number) =>
      upstream.heads?.[number] ??
      stack.find((candidate) => candidate.number === number)!.mergedHead,
    isAncestorOfHead: (candidate) => upstream.inHead?.includes(candidate) ?? false,
    merge: (head, _message, listText) => {
      const conflicts = upstream.conflicts?.[head] ?? [];
      if (conflicts.length === 0) merges.push({ commit: head, list: parseAdoptedList(listText) });
      return conflicts;
    },
    commitList: (_message, listText) => listCommits.push(parseAdoptedList(listText)),
    log: () => {},
  };
  return { io, merges, listCommits };
}

it("changes nothing when every pull request is open at its listed head", () => {
  const { io, merges, listCommits } = fakeIo({});
  const result = syncAdoptedPullRequests(stack, io);
  assert.deepStrictEqual(result, { _tag: "Done", list: stack });
  assert.deepStrictEqual(merges, []);
  assert.deepStrictEqual(listCommits, []);
});

it("merges new heads in stack order, each merge commit with the updated list", () => {
  const { io, merges, listCommits } = fakeIo({ heads: { 1: commit("d"), 3: commit("e") } });
  const result = syncAdoptedPullRequests(stack, io);
  assert.deepStrictEqual(
    merges.map((merge) => merge.commit),
    [commit("d"), commit("e")],
  );
  assert.deepStrictEqual(
    merges[0]?.list.map((pr) => pr.mergedHead),
    [commit("d"), commit("b"), commit("c")],
  );
  const expected = [commit("d"), commit("b"), commit("e")];
  assert.deepStrictEqual(
    merges[1]?.list.map((pr) => pr.mergedHead),
    expected,
  );
  assert.deepStrictEqual(listCommits, []);
  assert.strictEqual(result._tag, "Done");
  if (result._tag === "Done") {
    assert.deepStrictEqual(
      result.list.map((pr) => pr.mergedHead),
      expected,
    );
  }
});

it("only updates the listed head when HEAD already has the new head", () => {
  const { io, merges, listCommits } = fakeIo({ heads: { 2: commit("f") }, inHead: [commit("f")] });
  syncAdoptedPullRequests(stack, io);
  assert.deepStrictEqual(merges, []);
  assert.deepStrictEqual(
    listCommits.map((list) => list.map((pr) => pr.mergedHead)),
    [[commit("a"), commit("f"), commit("c")]],
  );
});

it("drops a pull request that upstream main in HEAD merged, and keeps one merged elsewhere", () => {
  const { io, merges, listCommits } = fakeIo({
    states: {
      1: { state: "MERGED", mergeCommit: commit("1") },
      2: { state: "MERGED", mergeCommit: commit("2") },
    },
    inHead: [commit("1")],
  });
  const result = syncAdoptedPullRequests(stack, io);
  assert.deepStrictEqual(merges, []);
  assert.deepStrictEqual(listCommits, [[stack[1], stack[2]]]);
  assert.deepStrictEqual(result, { _tag: "Done", list: [stack[1], stack[2]] });
});

it("writes a drop into the next merge commit instead of a separate commit", () => {
  const { io, merges, listCommits } = fakeIo({
    states: { 1: { state: "MERGED", mergeCommit: commit("1") } },
    heads: { 2: commit("d") },
    inHead: [commit("1")],
  });
  syncAdoptedPullRequests(stack, io);
  assert.deepStrictEqual(
    merges.map((merge) => merge.list.map((pr) => pr.number)),
    [[2, 3]],
  );
  assert.deepStrictEqual(listCommits, []);
});

it("stops at a pull request that upstream closed without a merge", () => {
  const { io, merges } = fakeIo({ states: { 2: { state: "CLOSED" } }, heads: { 3: commit("e") } });
  const result = syncAdoptedPullRequests(stack, io);
  assert.strictEqual(result._tag, "Stopped");
  if (result._tag === "Stopped") assert.include(result.reason, "#2");
  assert.deepStrictEqual(merges, []);
});

it("stops at a conflict and names the pull request and the paths", () => {
  const { io, merges } = fakeIo({
    heads: { 2: commit("d"), 3: commit("e") },
    conflicts: { [commit("d")]: ["apps/server/src/server.ts"] },
  });
  const result = syncAdoptedPullRequests(stack, io);
  assert.strictEqual(result._tag, "Stopped");
  if (result._tag === "Stopped") {
    assert.include(result.reason, "#2");
    assert.include(result.details, "apps/server/src/server.ts");
  }
  assert.deepStrictEqual(merges, []);
});

it("parses its own format and rejects invalid entries", () => {
  const text = serializeAdoptedList([...stack, { ...entry(4, commit("d")), forkRules: "rules" }]);
  assert.strictEqual(serializeAdoptedList(parseAdoptedList(text)), text);
  const invalid = (value: unknown) => () => parseAdoptedList(JSON.stringify([value]));
  assert.throws(invalid({ ...stack[0], mergedHead: "abc1234" }), /mergedHead/);
  assert.throws(invalid({ ...stack[0], title: "" }), /title/);
  assert.throws(invalid({ ...stack[0], number: 1.5 }), /number/);
  assert.throws(invalid({ ...stack[0], extra: true }), /unknown keys/);
  assert.throws(() => parseAdoptedList(JSON.stringify([stack[0], stack[0]])), /twice/);
});

it("finds a listed pull request whose upstream squash commit HEAD holds", () => {
  const subjects = [
    "feat(server): pull request 2 (#2)",
    "Merge pull request #3 from Yarden-zamir/branch",
    "fix(web): other (#12)",
  ];
  assert.deepStrictEqual(
    mergedUpstreamProblems(stack, subjects).map((problem) => problem.split(":")[0]),
    ["#2"],
  );
});
