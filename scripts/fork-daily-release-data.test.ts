import { assert, it } from "@effect/vitest";

import {
  breakingSection,
  type FirstParentChange,
  type GitCommit,
  decodeReleaseImages,
  extractImages,
  withReleaseImages,
  type ForkChange,
  renderNotes,
  groupDailyChanges,
  withPullRequestBreaking,
} from "./fork-daily-release-data.ts";

const commit = (
  sha: string,
  subject: string,
  parents: ReadonlyArray<string> = ["p"],
  body = "",
): GitCommit => ({
  sha,
  parents,
  author: `author of ${sha}`,
  committedAt: "2026-10-20T10:00:00Z",
  subject,
  body,
});

const upstreamShas = new Set(["u1", "u2", "u3", "um"]);
const isUpstream = (sha: string) => upstreamShas.has(sha);

const changes: ReadonlyArray<FirstParentChange> = [
  {
    commit: commit(
      "m1",
      "Merge pull request #10 from Yarden-zamir/feat/a",
      ["p", "b1"],
      "feat: a\n",
    ),
    brought: [commit("b1", "feat: a")],
    branchAuthor: "Yarden",
  },
  {
    commit: commit("s1", "chore(sync): merge pingdotgg/t3code main", ["m1", "u1"]),
    brought: [commit("u1", "fix: one (#501)")],
    branchAuthor: "upstream author",
  },
  { commit: commit("d1", "docs(fork): direct"), brought: [], branchAuthor: undefined },
  {
    commit: commit(
      "m2",
      "Merge pull request #11 from Yarden-zamir/fork-sync/x",
      ["d1", "f1"],
      "chore(sync): merge upstream main\n",
    ),
    brought: [
      commit("f1", "fix(fork): keep a fork feature"),
      commit("fm", "Merge remote-tracking branch 'upstream/main'", ["d1", "um"]),
      commit("um", "Merge upstream branch", ["u2", "u3"]),
      commit("u3", "feat: three"),
      commit("u2", "feat: two (#502)"),
    ],
    branchAuthor: "Yarden",
  },
];

it("sorts pull requests, direct commits and upstream merges into the three groups", () => {
  const grouped = groupDailyChanges(changes, isUpstream, false);
  assert.deepStrictEqual(
    grouped.fork.map((change) => [change.source._tag, change.title, change.author]),
    [
      ["PullRequest", "feat: a", "Yarden"],
      ["Commit", "docs(fork): direct", "author of d1"],
    ],
  );
  assert.deepStrictEqual(
    grouped.integration.map((change) => ({
      title: change.title,
      upstreamCommitCount: change.upstreamCommitCount,
      fixes: change.fixes.map((fix) => fix.sha),
    })),
    [
      { title: "chore(sync): merge pingdotgg/t3code main", upstreamCommitCount: 1, fixes: [] },
      { title: "chore(sync): merge upstream main", upstreamCommitCount: 2, fixes: ["f1"] },
    ],
  );
  // Upstream merge commits are not changes. A squash merge links its pull request.
  assert.deepStrictEqual(
    grouped.upstream.map((change) => [change.sha, change.pullRequest?.number ?? null]),
    [
      ["u1", 501],
      ["u3", null],
      ["u2", 502],
    ],
  );
});

it("keeps only the last upstream merge for the first release", () => {
  const grouped = groupDailyChanges(changes, isUpstream, true);
  assert.deepStrictEqual(
    grouped.upstream.map((change) => change.sha),
    ["u3", "u2"],
  );
  assert.strictEqual(grouped.integration.length, 2);
});

it("lists the fork commits of a direct merge of fork branches", () => {
  const grouped = groupDailyChanges(
    [
      {
        commit: commit("dm", "Merge remote-tracking branch 'origin/main' into feat/b", ["p", "f2"]),
        brought: [commit("f2", "feat(fork): b")],
        branchAuthor: "Yarden",
      },
    ],
    isUpstream,
    false,
  );
  assert.deepStrictEqual(
    grouped.fork.map((change) => change.title),
    ["feat(fork): b"],
  );
  assert.strictEqual(grouped.integration.length, 0);
});

it("collects the images of a pull request body in order, without badges and hidden examples", () => {
  const body = [
    "[![CI](https://img.shields.io/badge/ci-passing-green)](https://example.com)",
    "Before:",
    "![Before the fix](https://github.com/user-attachments/assets/before)",
    '<img width="1200" alt="After the fix" src="https://github.com/user-attachments/assets/after">',
    "<!-- ![Template example](https://example.com/template.png) -->",
    "```md",
    "![In code](https://example.com/code.png)",
    "```",
    "![Before again](https://github.com/user-attachments/assets/before)",
  ].join("\n");
  assert.deepStrictEqual(extractImages(body), [
    { url: "https://github.com/user-attachments/assets/before", alt: "Before the fix" },
    { url: "https://github.com/user-attachments/assets/after", alt: "After the fix" },
  ]);
});

const pullRequest = (number: number, images = 0): ForkChange => ({
  source: {
    _tag: "PullRequest",
    number,
    url: `https://github.com/Yarden-zamir/t3code/pull/${number}`,
  },
  images: Array.from({ length: images }, (_, index) => ({
    url: `https://github.com/user-attachments/assets/${number}-${index}`,
    alt: `Shot ${index}`,
  })),
  title: `feat: change ${number}`,
  author: "Yarden",
  at: "2026-10-20T10:00:00Z",
  breaking: false,
  breakingNote: null,
});

const forkOnly = (fork: ReadonlyArray<ForkChange>) => ({ fork, upstream: [], integration: [] });
const emptySection = { clusters: [] };

it("renders clusters in plan order, highlights first and their changes folded", () => {
  const notes = renderNotes(forkOnly([pullRequest(1), pullRequest(2, 1), pullRequest(3)]), {
    intro: "Intro.",
    fork: {
      highlights: 1,
      clusters: [
        { name: "Big", sentence: "It matters.", changes: ["#2", "#1"] },
        { name: "Small", sentence: "It helps.", changes: ["#3"] },
      ],
    },
    upstream: emptySection,
    integration: emptySection,
  });
  const [highlights = "", full = ""] = notes.split("## Full changelog");
  assert.isTrue(highlights.includes("- **Big** ([#2]"));
  assert.isFalse(highlights.includes("**Small**"));
  assert.isTrue(full.indexOf("**Big**") < full.indexOf("**Small**"));
  assert.isTrue(full.includes("<summary>2 changes, with screenshots</summary>"));
  // The main change comes first in the fold, and its screenshots nest under it.
  assert.isTrue(full.indexOf("  - [#2]") < full.indexOf("    <details><summary>Screenshots"));
  assert.isTrue(full.indexOf("    <details><summary>Screenshots") < full.indexOf("  - [#1]"));
});

it("names every unknown, repeated and missing ref of a plan", () => {
  assert.throws(
    () =>
      renderNotes(forkOnly([pullRequest(1), pullRequest(2), pullRequest(3)]), {
        intro: "",
        fork: {
          clusters: [
            { name: "A", sentence: "", changes: ["#1", "#9"] },
            { name: "B", sentence: "", changes: ["#1"] },
          ],
        },
        upstream: emptySection,
        integration: emptySection,
      }),
    /"#9" names no change[\s\S]*"#1" is in more than one cluster[\s\S]*"#2"[\s\S]*"#3"/,
  );
});

it("drops the screenshots of the last clusters first when the notes are too big", () => {
  const changes = forkOnly([pullRequest(1, 1), pullRequest(2, 1)]);
  const plan = {
    intro: "",
    fork: {
      highlights: 0,
      clusters: [
        { name: "First", sentence: "", changes: ["#1"] },
        { name: "Second", sentence: "", changes: ["#2"] },
      ],
    },
    upstream: emptySection,
    integration: emptySection,
  };
  const full = renderNotes(changes, plan);
  const trimmed = renderNotes(changes, plan, full.length - 1);
  assert.isTrue(trimmed.includes("assets/1-0"));
  assert.isFalse(trimmed.includes("assets/2-0"));
  assert.throws(() => renderNotes(changes, plan, 10), /over the budget/);
});

it("shows only the images that the plan picks, and fails for an image of another change", () => {
  const changes = forkOnly([pullRequest(1, 2), pullRequest(2, 2), pullRequest(3, 1)]);
  const plan = (images: ReadonlyArray<string>) => ({
    intro: "",
    fork: {
      clusters: [
        { name: "Picked", sentence: "", changes: ["#1", "#2"], images },
        { name: "Other", sentence: "", changes: ["#3"] },
      ],
    },
    upstream: emptySection,
    integration: emptySection,
  });
  const notes = renderNotes(changes, plan(["https://github.com/user-attachments/assets/2-1"]));
  const picked = notes.split("**Other**")[0] ?? "";
  // A follow-up change can give the image. The other images of the cluster stay out.
  assert.isTrue(picked.includes("assets/2-1"));
  assert.isFalse(["assets/1-0", "assets/1-1", "assets/2-0"].some((url) => notes.includes(url)));

  const none = renderNotes(changes, plan([]));
  assert.isFalse(none.includes("assets/1-0") || none.includes("assets/2-1"));
  assert.isTrue(none.includes("assets/3-0"));

  assert.throws(
    () => renderNotes(changes, plan(["https://github.com/user-attachments/assets/3-0"])),
    /"Picked" names an image that none of its changes has/,
  );
});

it("adds the images of release-images.json to the change that its ref names", () => {
  const shot = { url: "https://github.com/user-attachments/assets/extra", alt: "Extra" };
  const releaseImages = decodeReleaseImages({ "#1": [shot], abcdef1234567: [shot] });
  const commit: ForkChange = {
    ...pullRequest(9),
    source: { _tag: "Commit", sha: "abcdef1234567", url: "https://example.com/c" },
  };
  assert.deepStrictEqual(withReleaseImages(commit, releaseImages).images, [shot]);
  // A pull request keeps its body images first, and an image in both places shows once.
  const withBody = { ...pullRequest(1, 1), images: [pullRequest(1, 1).images[0]!, shot] };
  assert.deepStrictEqual(withReleaseImages(withBody, releaseImages).images, withBody.images);
  assert.deepStrictEqual(withReleaseImages(pullRequest(2), releaseImages).images, []);
  assert.throws(() => decodeReleaseImages({ "#1": [{ url: "http://x" }] }), /needs a list/);
});

it("marks a change breaking from its title, a commit footer, a body section or a label", () => {
  const grouped = groupDailyChanges(
    [
      {
        commit: commit(
          "m1",
          "Merge pull request #1 from Yarden-zamir/a",
          ["p", "b1"],
          "feat(web)!: a\n",
        ),
        brought: [commit("b1", "feat(web)!: a")],
        branchAuthor: "Yarden",
      },
      {
        commit: commit("m2", "Merge pull request #2 from Yarden-zamir/b", ["p", "b2"], "fix: b\n"),
        brought: [
          commit(
            "b2",
            "fix: b",
            ["p"],
            "Body.\n\nBREAKING CHANGE: the old key is gone.\nMove it.\n",
          ),
        ],
        branchAuthor: "Yarden",
      },
      { commit: commit("d3", "fix: c, no mark"), brought: [], branchAuthor: undefined },
    ],
    isUpstream,
    false,
  );
  assert.deepStrictEqual(
    grouped.fork.map((change) => [change.breaking, change.breakingNote]),
    [
      [true, null],
      [true, "the old key is gone.\nMove it."],
      [false, null],
    ],
  );

  const body =
    "Intro.\n\n## 🤖 Breaking changes\n\n- Key renamed. To do: update.\n\n## Checks\n\nAll pass.";
  assert.strictEqual(breakingSection(body), "- Key renamed. To do: update.");
  const plain = grouped.fork[2]!;
  const fromBody = withPullRequestBreaking(plain, { title: "fix: c", body, labels: [] });
  assert.deepStrictEqual(
    [fromBody.breaking, fromBody.breakingNote],
    [true, "- Key renamed. To do: update."],
  );
  const fromLabel = withPullRequestBreaking(plain, {
    title: "fix: c",
    body: "",
    labels: ["breaking"],
  });
  assert.isTrue(fromLabel.breaking);
  assert.isFalse(
    withPullRequestBreaking(plain, { title: "fix: c", body: "", labels: [] }).breaking,
  );
});

it("puts breaking changes at the top and fails when one has no line", () => {
  const breakingChange: ForkChange = {
    ...pullRequest(7),
    breaking: true,
    breakingNote: "Key renamed.",
  };
  const changes = forkOnly([pullRequest(1), breakingChange]);
  const plan = (breaking: ReadonlyArray<{ section: "fork"; change: string; line: string }>) => ({
    intro: "Intro.",
    breaking,
    fork: { clusters: [{ name: "All", sentence: "", changes: ["#7", "#1"] }] },
    upstream: emptySection,
    integration: emptySection,
  });
  const notes = renderNotes(
    changes,
    plan([{ section: "fork", change: "#7", line: "Key renamed. Update every machine." }]),
  );
  assert.isTrue(notes.startsWith("## ⚠️ Breaking changes"));
  assert.isTrue(notes.indexOf("Key renamed. Update every machine.") < notes.indexOf("Intro."));
  // The desktop update popover reads the last lines above "Full changelog".
  const [aboveFull = ""] = notes.split("## Full changelog");
  assert.isTrue(aboveFull.trimEnd().split("\n").at(-1)!.startsWith("⚠️ Breaking changes: [#7]"));

  assert.throws(
    () => renderNotes(changes, plan([])),
    /"#7" \(feat: change 7\) is breaking and has no line/,
  );
  assert.throws(
    () => renderNotes(changes, plan([{ section: "fork", change: "#1", line: "Not breaking." }])),
    /"#1" names no breaking change/,
  );
});
