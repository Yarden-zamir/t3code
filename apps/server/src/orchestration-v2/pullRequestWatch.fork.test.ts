import {
  DEFAULT_SERVER_SETTINGS,
  SourceControlProviderKind,
  type PullRequestCheck,
  PullRequestComment,
  type PullRequestWatchRemarkFilter,
  ThreadPullRequestWatch,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { evaluatePullRequestWatch as evaluate } from "./pullRequestWatch.ts";

type EvaluateArgs = Parameters<typeof evaluate>;
const evaluatePullRequestWatch = (
  current: EvaluateArgs[0],
  pullRequest: EvaluateArgs[1],
  remarks: EvaluateArgs[2],
  remarkFilter?: EvaluateArgs[4],
) => evaluate(current, pullRequest, remarks, 0, remarkFilter);

const STARTED = "2026-10-02T12:00:00.000Z";

const watch = (overrides: Partial<ThreadPullRequestWatch> = {}): ThreadPullRequestWatch => ({
  startedAt: STARTED,
  headSha: null,
  failedChecks: [],
  passed: false,
  passedChecks: [],
  remarksThrough: STARTED,
  remarkIds: [],
  conflicting: false,
  wakes: 0,
  ...overrides,
});

const check = (name: string, status: PullRequestCheck["status"]): PullRequestCheck => ({
  name,
  status,
  description: null,
  url: `https://ci.example/${name}`,
});

type Detail = Parameters<typeof evaluatePullRequestWatch>[1];

const detail = (overrides: Partial<Detail> = {}): Detail => ({
  provider: SourceControlProviderKind.make("github"),
  headSha: "aaaaaaaaaa",
  checks: [check("lint", "success"), check("test", "pending")],
  mergeability: "mergeable",
  viewer: "agent-user",
  author: { login: "agent-user", name: null, avatarUrl: null },
  ...overrides,
});

const remark = (
  login: string,
  createdAt: string,
  body = "Please rename this.",
): PullRequestComment => ({
  id: `${login}-${createdAt}`,
  kind: "review-comment",
  author: { login, name: null, avatarUrl: null },
  body,
  createdAt,
  url: `https://github.com/o/r/pull/1#${login}`,
  path: "src/index.ts",
  reviewState: null,
});

describe("evaluatePullRequestWatch remark filter", () => {
  const at = "2026-10-02T12:06:00Z";
  const marker = "<!-- agent -->";
  const filter = (
    overrides: Partial<PullRequestWatchRemarkFilter> = {},
  ): PullRequestWatchRemarkFilter => ({
    ...DEFAULT_SERVER_SETTINGS.pullRequestWatchRemarkFilter,
    ...overrides,
  });
  const ours = filter({ authorAssociations: ["OWNER", "MEMBER", "COLLABORATOR"] });
  /** A remark by `login`, with the role GitHub reports for it, or none. */
  const by = (login: string, authorAssociation?: string, body?: string): PullRequestComment => ({
    ...remark(login, at, body),
    id: `${login}-${authorAssociation ?? "none"}-${body ?? ""}`,
    ...(authorAssociation === undefined ? {} : { authorAssociation }),
  });
  const woken = (
    remarks: ReadonlyArray<PullRequestComment>,
    remarkFilter: PullRequestWatchRemarkFilter,
  ) =>
    evaluatePullRequestWatch(watch(), detail(), remarks, remarkFilter).changes.flatMap((change) =>
      change.kind === "remarks" ? change.remarks.map((remark) => remark.id) : [],
    );

  it("keeps the own-account rule when the setting is off", () => {
    const remarks = [
      by("agent-user", "OWNER"),
      by("reviewer", "NONE"),
      by("dependabot[bot]", "NONE"),
    ];
    assert.deepEqual(woken(remarks, filter()), [remarks[1]!.id, remarks[2]!.id]);
  });

  it("wakes for allowed roles, the server's own account too, and not for others", () => {
    const owner = by("agent-user", "OWNER");
    const collaborator = by("TomCohenDev", "collaborator");
    const remarks = [
      owner,
      collaborator,
      by("drive-by", "CONTRIBUTOR"),
      by("stranger", "NONE"),
      // A GitHub App has no role on the repository.
      by("tick3d-agents[bot]", "NONE"),
      by("dependabot[bot]", "NONE"),
    ];
    assert.deepEqual(woken(remarks, ours), [owner.id, collaborator.id]);
  });

  it("counts a remark without a reported role only through the login list", () => {
    const listed = by("TomCohenDev");
    const unlisted = by("reviewer");
    assert.deepEqual(woken([listed, unlisted], ours), []);
    assert.deepEqual(woken([listed, unlisted], { ...ours, authorLogins: ["tomcohendev"] }), [
      listed.id,
    ]);
  });

  it("wakes for listed logins whatever their role", () => {
    const remarks = [by("agent-user", "OWNER"), by("helper", "NONE"), by("reviewer", "NONE")];
    assert.deepEqual(woken(remarks, filter({ authorLogins: ["Helper"] })), [remarks[1]!.id]);
  });

  it("never wakes for a remark with the agent marker, even from an allowed author", () => {
    const marked = by("agent-user", "OWNER", `${marker}\nPushed the fix.`);
    const listed = by("helper", "NONE", `Done. ${marker}`);
    const plain = by("agent-user", "OWNER", "Please also cover the empty case.");
    const remarkFilter = { ...ours, authorLogins: ["helper"], agentMarker: marker };
    assert.deepEqual(woken([marked, listed, plain], remarkFilter), [plain.id]);
  });

  it("with only a marker, skips marked remarks and keeps the own-account rule", () => {
    const marked = by("reviewer", "OWNER", `Done. ${marker}`);
    const own = by("agent-user", "OWNER");
    const plain = by("reviewer", "NONE", "Looks good.");
    assert.deepEqual(woken([marked, own, plain], filter({ agentMarker: marker })), [plain.id]);
  });

  it("does not change check and conflict news", () => {
    const strict = { ...ours, agentMarker: marker };
    const failing = detail({ checks: [check("lint", "failure")], mergeability: "conflicting" });
    const report = evaluatePullRequestWatch(watch(), failing, [by("stranger", "NONE")], strict);
    assert.deepEqual(report.changes, [
      { kind: "checks-failed", failed: [check("lint", "failure")] },
      { kind: "conflicting" },
    ]);
    const green = detail({ checks: [check("lint", "success")] });
    assert.deepEqual(evaluatePullRequestWatch(report.next, green, [], strict).changes, [
      { kind: "checks-passed", count: 1, required: false },
    ]);
  });
});
