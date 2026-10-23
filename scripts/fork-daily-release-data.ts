#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - plain Node, so the daily release task runs it without `vp i`.
// Fork: collects the data of the daily release. See docs/fork/operations.md "Daily release".
//
//   node scripts/fork-daily-release-data.ts [--release <tag>] [--since <ref>] [--notes <plan.json>]
//
// It picks the newest complete nightly on fork main after the previous stable release, and
// prints JSON with the changes since that stable release, in three groups: fork changes,
// upstream changes and the integration of upstream into the fork. An agent writes the notes
// from it and promotes the nightly. Without a stable release, the range starts where the fork
// began, and the upstream group holds only the commits of the last upstream merge.
// With --release, it writes the data of that release again, for example after a promotion.
// With --notes, it prints the release notes as markdown instead. The plan file, written by the
// agent, groups the changes into clusters and orders them (NotesPlan).
// Each pull request item carries the images of its body; the notes show them in a collapsed block.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import { classifyFirstParentCommit, escapeText } from "./fork-release-notes.ts";

const FORK_REPOSITORY = "Yarden-zamir/t3code";
const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
/** Fork Release uploads it last, so a release with it is complete. See forkReleases.ts. */
const COMPLETE_RELEASE_ASSET = "SHA256SUMS";

export interface GitCommit {
  readonly sha: string;
  readonly parents: ReadonlyArray<string>;
  readonly author: string;
  /** ISO 8601. */
  readonly committedAt: string;
  readonly subject: string;
  readonly body: string;
}

/** A first-parent commit of fork main, with the commits that its merge brought in. */
export interface FirstParentChange {
  readonly commit: GitCommit;
  /** For a merge: the commits it brought that the range did not already hold. Else empty. */
  readonly brought: ReadonlyArray<GitCommit>;
  /** The author of a pull request branch head. Undefined for a direct commit. */
  readonly branchAuthor: string | undefined;
}

export type ChangeSource =
  | { readonly _tag: "PullRequest"; readonly number: number; readonly url: string }
  | { readonly _tag: "Commit"; readonly sha: string; readonly url: string };

export interface PullRequestImage {
  readonly url: string;
  readonly alt: string;
}

export interface ForkChange {
  readonly source: ChangeSource;
  /** From the pull request body. Empty for a commit. */
  readonly images: ReadonlyArray<PullRequestImage>;
  readonly title: string;
  readonly author: string;
  /** ISO 8601. The merge time of a pull request, the commit time of a commit. */
  readonly at: string;
}

export interface UpstreamChange {
  readonly sha: string;
  readonly url: string;
  readonly title: string;
  readonly author: string;
  /** Upstream squash merges end their subject with `(#123)`. */
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
  readonly images: ReadonlyArray<PullRequestImage>;
}

export interface IntegrationChange extends ForkChange {
  readonly upstreamCommitCount: number;
  /** The fork commits of the merge: conflict resolutions and fixes. */
  readonly fixes: ReadonlyArray<{
    readonly sha: string;
    readonly url: string;
    readonly title: string;
  }>;
}

export interface DailyChanges {
  readonly fork: ReadonlyArray<ForkChange>;
  readonly upstream: ReadonlyArray<UpstreamChange>;
  readonly integration: ReadonlyArray<IntegrationChange>;
}

const commitUrl = (repository: string, sha: string) =>
  `https://github.com/${repository}/commit/${sha}`;

function upstreamPullRequest(subject: string): UpstreamChange["pullRequest"] {
  const trimmed = subject.trimEnd();
  if (!trimmed.endsWith(")")) return null;
  const start = trimmed.lastIndexOf("(#");
  if (start === -1) return null;
  const number = Number(trimmed.slice(start + 2, -1));
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { number, url: `https://github.com/${UPSTREAM_REPOSITORY}/pull/${number}` };
}

function toUpstreamChange(commit: GitCommit): UpstreamChange {
  return {
    sha: commit.sha,
    url: commitUrl(UPSTREAM_REPOSITORY, commit.sha),
    title: commit.subject,
    author: commit.author,
    pullRequest: upstreamPullRequest(commit.subject),
    images: [],
  };
}

function toForkCommit(commit: GitCommit): ForkChange {
  return {
    source: { _tag: "Commit", sha: commit.sha, url: commitUrl(FORK_REPOSITORY, commit.sha) },
    images: [],
    title: commit.subject,
    author: commit.author,
    at: commit.committedAt,
  };
}

const isMerge = (commit: GitCommit) => commit.parents.length > 1;

/**
 * Sorts the first-parent commits of a range, oldest first, into the three groups. A commit that
 * brings upstream commits is integration work, and its own fork commits are its fixes. With
 * `onlyLastUpstreamMerge`, the upstream group holds only the commits of the newest such merge.
 */
export function groupDailyChanges(
  changes: ReadonlyArray<FirstParentChange>,
  isUpstream: (sha: string) => boolean,
  onlyLastUpstreamMerge: boolean,
): DailyChanges {
  const fork: ForkChange[] = [];
  const integration: IntegrationChange[] = [];
  const upstreamByMerge: UpstreamChange[][] = [];

  for (const { commit, brought, branchAuthor } of changes) {
    const kind = classifyFirstParentCommit(commit);
    const upstream = brought.filter((candidate) => isUpstream(candidate.sha));
    const upstreamChanges = upstream
      .filter((candidate) => !isMerge(candidate))
      .map(toUpstreamChange);
    const forkSide = brought.filter(
      (candidate) => !isUpstream(candidate.sha) && !isMerge(candidate),
    );
    const change: ForkChange =
      kind._tag === "PullRequest"
        ? {
            source: {
              _tag: "PullRequest",
              number: kind.number,
              url: `https://github.com/${FORK_REPOSITORY}/pull/${kind.number}`,
            },
            images: [],
            title: kind.title,
            author: branchAuthor ?? commit.author,
            at: commit.committedAt,
          }
        : toForkCommit(commit);

    if (upstream.length > 0) {
      integration.push({
        ...change,
        upstreamCommitCount: upstreamChanges.length,
        fixes: forkSide.map((fix) => ({
          sha: fix.sha,
          url: commitUrl(FORK_REPOSITORY, fix.sha),
          title: fix.subject,
        })),
      });
      upstreamByMerge.push(upstreamChanges);
    } else if (kind._tag === "PullRequest" || !isMerge(commit)) {
      fork.push(change);
    } else {
      // A direct merge of fork branches, from before the fork used pull requests.
      fork.push(...forkSide.map(toForkCommit));
    }
  }

  return {
    fork,
    upstream: onlyLastUpstreamMerge ? (upstreamByMerge.at(-1) ?? []) : upstreamByMerge.flat(),
    integration,
  };
}

/** Text outside HTML comments and fenced code blocks: pull request templates hide examples there. */
function visibleMarkdown(body: string): string {
  let text = "";
  let rest = body;
  for (let start = rest.indexOf("<!--"); start !== -1; start = rest.indexOf("<!--")) {
    const end = rest.indexOf("-->", start + 4);
    text += rest.slice(0, start);
    rest = end === -1 ? "" : rest.slice(end + 3);
  }
  text += rest;
  let inFence = false;
  return text
    .split("\n")
    .filter((line) => {
      if (line.trimStart().startsWith("```")) {
        inFence = !inFence;
        return false;
      }
      return !inFence;
    })
    .join("\n");
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const lower = tag.toLowerCase();
  for (const quote of ['"', "'"]) {
    const marker = ` ${name}=${quote}`;
    const start = lower.indexOf(marker);
    if (start === -1) continue;
    const valueStart = start + marker.length;
    const end = tag.indexOf(quote, valueStart);
    if (end !== -1) return tag.slice(valueStart, end);
  }
  return undefined;
}

/** A badge, or a video that an image tag cannot show. */
function isSkipped(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    [".mp4", ".mov", ".webm"].some((extension) => lower.endsWith(extension)) ||
    lower.includes("shields.io") ||
    lower.includes("badgen.net") ||
    lower.includes("/badge") ||
    lower.endsWith("badge.svg")
  );
}

/** The markdown images and `<img>` tags of a pull request body, in order, without badges and videos. */
export function extractImages(body: string): PullRequestImage[] {
  const text = visibleMarkdown(body);
  const found: Array<PullRequestImage & { readonly at: number }> = [];
  for (let at = text.indexOf("!["); at !== -1; at = text.indexOf("![", at + 2)) {
    const altEnd = text.indexOf("](", at + 2);
    const urlEnd = altEnd === -1 ? -1 : text.indexOf(")", altEnd + 2);
    if (altEnd === -1 || urlEnd === -1 || text.slice(at + 2, altEnd).includes("\n")) continue;
    const url =
      text
        .slice(altEnd + 2, urlEnd)
        .trim()
        .split(" ")[0] ?? "";
    found.push({ at, url, alt: text.slice(at + 2, altEnd).trim() });
  }
  const lower = text.toLowerCase();
  for (let at = lower.indexOf("<img"); at !== -1; at = lower.indexOf("<img", at + 4)) {
    const end = text.indexOf(">", at);
    if (end === -1) break;
    const tag = text.slice(at, end).replaceAll("\n", " ");
    found.push({ at, url: htmlAttribute(tag, "src") ?? "", alt: htmlAttribute(tag, "alt") ?? "" });
  }
  const images = new Map<string, PullRequestImage>();
  for (const { url, alt } of found.toSorted((left, right) => left.at - right.at)) {
    if (url.startsWith("https://") && !isSkipped(url) && !images.has(url))
      images.set(url, { url, alt });
  }
  return [...images.values()];
}

const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

const MAX_IMAGES_PER_ITEM = 4;
const MAX_ALT_LENGTH = 100;
/** GitHub limits a release body to 125000 characters. */
const NOTES_BUDGET = 120_000;
const DEFAULT_HIGHLIGHTS = 5;

function imageLines(
  images: ReadonlyArray<PullRequestImage>,
  pullRequestUrl: string,
  indent: string,
): string[] {
  const hidden = images.length - MAX_IMAGES_PER_ITEM;
  return [
    ...images.slice(0, MAX_IMAGES_PER_ITEM).map((image) => {
      const alt =
        image.alt.length > MAX_ALT_LENGTH
          ? `${image.alt.slice(0, MAX_ALT_LENGTH - 3)}...`
          : image.alt;
      return `${indent}<img src="${escapeAttribute(image.url)}" alt="${escapeAttribute(alt)}" width="600">`;
    }),
    ...(hidden > 0 ? ["", `${indent}[${hidden} more in the pull request](${pullRequestUrl})`] : []),
  ];
}

/**
 * The collapsed screenshots block under a list item, indented so that GitHub keeps it inside the
 * item. The desktop update popover drops `<details>` blocks (apps/desktop/src/updates/releaseNotes.ts).
 */
export function renderScreenshots(
  images: ReadonlyArray<PullRequestImage>,
  pullRequestUrl: string,
  indent = "  ",
): string[] {
  if (images.length === 0) return [];
  return [
    `${indent}<details><summary>Screenshots</summary>`,
    "",
    ...imageLines(images, pullRequestUrl, indent),
    `${indent}</details>`,
  ];
}

function sourceLink(source: ChangeSource): string {
  return source._tag === "PullRequest"
    ? `[#${source.number}](${source.url})`
    : `[${source.sha.slice(0, 7)}](${source.url})`;
}

/** Without the `(#123)` suffix: in a fork release, GitHub would link it to a fork pull request. */
function upstreamTitle(change: UpstreamChange): string {
  if (change.pullRequest === null) return change.title;
  return change.title.slice(0, change.title.lastIndexOf("(#")).trimEnd();
}

/** How a notes plan names a change: `#123` for a pull request, else the full commit. */
export function forkChangeRef(change: ForkChange): string {
  return change.source._tag === "PullRequest" ? `#${change.source.number}` : change.source.sha;
}

export function upstreamChangeRef(change: UpstreamChange): string {
  return change.pullRequest === null ? change.sha : `#${change.pullRequest.number}`;
}

export interface ClusterPlan {
  readonly name: string;
  /** One plain sentence on why the cluster matters. */
  readonly sentence: string;
  /** Refs of the changes, most important first. The first one is the main change. */
  readonly changes: ReadonlyArray<string>;
  /**
   * The image URLs to show, picked from the images of the cluster's changes. Empty shows none.
   * Absent shows the images of the first change that has any, and every change's own images.
   */
  readonly images?: ReadonlyArray<string>;
}

export interface SectionPlan {
  /** How many clusters, from the top, the highlights show. 5 when absent. */
  readonly highlights?: number;
  /** Most important and most visible first. */
  readonly clusters: ReadonlyArray<ClusterPlan>;
}

/** Written by the agent: which changes belong together, and their order by cool factor. */
export interface NotesPlan {
  readonly intro: string;
  readonly fork: SectionPlan;
  readonly upstream: SectionPlan;
  readonly integration: SectionPlan;
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function decodeSectionPlan(value: unknown, name: string): SectionPlan {
  const section = value as { highlights?: unknown; clusters?: unknown } | null;
  if (typeof section !== "object" || section === null || !Array.isArray(section.clusters)) {
    throw new Error(`The notes plan needs "${name}.clusters" as an array.`);
  }
  if (
    section.highlights !== undefined &&
    !(Number.isSafeInteger(section.highlights) && (section.highlights as number) >= 0)
  ) {
    throw new Error(`"${name}.highlights" must be a whole number, 0 or more.`);
  }
  const clusters = section.clusters.map((cluster: unknown, index): ClusterPlan => {
    const candidate = cluster as Partial<Record<keyof ClusterPlan, unknown>> | null;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof candidate.name !== "string" ||
      typeof candidate.sentence !== "string" ||
      !isStringArray(candidate.changes) ||
      candidate.changes.length === 0 ||
      (candidate.images !== undefined && !isStringArray(candidate.images))
    ) {
      throw new Error(
        `"${name}.clusters[${index}]" needs a "name", a "sentence", at least one ref in "changes", and "images" as a list of URLs when present.`,
      );
    }
    const plan = { name: candidate.name, sentence: candidate.sentence, changes: candidate.changes };
    return candidate.images === undefined ? plan : { ...plan, images: candidate.images };
  });
  return section.highlights === undefined
    ? { clusters }
    : { highlights: section.highlights as number, clusters };
}

export function decodeNotesPlan(value: unknown): NotesPlan {
  const plan = value as Partial<Record<keyof NotesPlan, unknown>> | null;
  if (typeof plan !== "object" || plan === null || typeof plan.intro !== "string") {
    throw new Error('The notes plan needs an "intro" text.');
  }
  return {
    intro: plan.intro,
    fork: decodeSectionPlan(plan.fork, "fork"),
    upstream: decodeSectionPlan(plan.upstream, "upstream"),
    integration: decodeSectionPlan(plan.integration, "integration"),
  };
}

interface NoteEntry {
  readonly ref: string;
  readonly link: string;
  readonly title: string;
  readonly images: ReadonlyArray<PullRequestImage>;
  readonly url: string;
  /** Nested lines under the entry, without indent. */
  readonly children: ReadonlyArray<string>;
}

function forkEntry(change: ForkChange): NoteEntry {
  return {
    ref: forkChangeRef(change),
    link: sourceLink(change.source),
    title: `${escapeText(change.title)} (${change.author})`,
    images: change.images,
    url: change.source.url,
    children: [],
  };
}

function upstreamEntry(change: UpstreamChange): NoteEntry {
  return {
    ref: upstreamChangeRef(change),
    link:
      change.pullRequest === null
        ? `[${change.sha.slice(0, 7)}](${change.url})`
        : `[upstream #${change.pullRequest.number}](${change.pullRequest.url})`,
    title: `${escapeText(upstreamTitle(change))} (${change.author})`,
    images: change.images,
    url: change.pullRequest?.url ?? change.url,
    children: [],
  };
}

function integrationEntry(change: IntegrationChange): NoteEntry {
  const commits = change.upstreamCommitCount === 1 ? "commit" : "commits";
  const fixes = change.fixes.length === 1 ? "fix" : "fixes";
  return {
    ...forkEntry(change),
    title: `${escapeText(change.title)}: ${change.upstreamCommitCount} upstream ${commits}, ${change.fixes.length} fork ${fixes}`,
    children: change.fixes.map(
      (fix) => `- [${fix.sha.slice(0, 7)}](${fix.url}) ${escapeText(fix.title)}`,
    ),
  };
}

/** A ref names a change by `#123`, or by its commit or a prefix of at least 7 characters. */
function refMatches(ref: string, entry: NoteEntry): boolean {
  if (ref.startsWith("#") || entry.ref.startsWith("#")) return ref === entry.ref;
  return ref.length >= 7 && entry.ref.startsWith(ref);
}

interface Cluster {
  readonly plan: ClusterPlan;
  readonly entries: ReadonlyArray<NoteEntry>;
  /** The images that the plan picked. Undefined when the plan picks none. */
  readonly picked: ReadonlyArray<PullRequestImage> | undefined;
}

/** Fails for a URL that no change of the cluster has, so that a plan cannot invent images. */
function pickImages(
  section: string,
  cluster: ClusterPlan,
  entries: ReadonlyArray<NoteEntry>,
  problems: string[],
): ReadonlyArray<PullRequestImage> | undefined {
  if (cluster.images === undefined) return undefined;
  const own = new Map(entries.flatMap((entry) => entry.images).map((image) => [image.url, image]));
  return cluster.images.flatMap((url) => {
    const image = own.get(url);
    if (image === undefined) {
      problems.push(
        `${section}: "${cluster.name}" names an image that none of its changes has: ${url}`,
      );
      return [];
    }
    return [image];
  });
}

/** Fails with every unknown, repeated and missing ref, so that the agent fixes the plan at once. */
function resolveClusters(
  section: string,
  plan: SectionPlan,
  entries: ReadonlyArray<NoteEntry>,
): Cluster[] {
  const problems: string[] = [];
  const used = new Set<NoteEntry>();
  const clusters = plan.clusters.map((cluster): Cluster => {
    const clusterEntries = cluster.changes.flatMap((ref) => {
      const matches = entries.filter((entry) => refMatches(ref, entry));
      const [entry] = matches;
      if (entry === undefined || matches.length > 1) {
        problems.push(
          `${section}: "${ref}" ${entry === undefined ? "names no change" : "names more than one change"}.`,
        );
        return [];
      }
      if (used.has(entry)) {
        problems.push(`${section}: "${ref}" is in more than one cluster.`);
        return [];
      }
      used.add(entry);
      return [entry];
    });
    return {
      plan: cluster,
      entries: clusterEntries,
      picked: pickImages(section, cluster, clusterEntries, problems),
    };
  });
  for (const entry of entries) {
    if (!used.has(entry))
      problems.push(`${section}: "${entry.ref}" (${entry.title}) is in no cluster.`);
  }
  if (problems.length > 0)
    throw new Error(`The notes plan does not match the changes:\n${problems.join("\n")}`);
  return clusters;
}

function clusterHead(cluster: Cluster): string {
  const main = cluster.entries[0];
  return `- **${cluster.plan.name}** (${main?.link ?? ""}): ${cluster.plan.sentence}`;
}

/** The picked images, or else the images of the first change that has any. */
function clusterScreenshots(cluster: Cluster): string[] {
  if (cluster.picked !== undefined) {
    return renderScreenshots(cluster.picked, cluster.entries[0]?.url ?? "");
  }
  const shown = cluster.entries.find((entry) => entry.images.length > 0);
  return shown === undefined ? [] : renderScreenshots(shown.images, shown.url);
}

const indentLines = (lines: ReadonlyArray<string>, indent: string) =>
  lines.map((line) => (line === "" ? line : `${indent}${line}`));

/** A cluster line, with its changes in a collapsed block below it. */
function renderCluster(cluster: Cluster, withoutImages: ReadonlySet<NoteEntry>): string[] {
  const count = cluster.entries.length;
  const { picked } = cluster;
  const hasImages =
    picked === undefined
      ? cluster.entries.some((entry) => entry.images.length > 0 && !withoutImages.has(entry))
      : picked.length > 0;
  return [
    clusterHead(cluster),
    `  <details><summary>${count} ${count === 1 ? "change" : "changes"}${hasImages ? ", with screenshots" : ""}</summary>`,
    "",
    // Picked images sit on top of the fold, instead of under each change.
    ...(picked === undefined || picked.length === 0
      ? []
      : [...imageLines(picked, cluster.entries[0]?.url ?? "", "  "), ""]),
    ...cluster.entries.flatMap((entry) => [
      `  - ${entry.link} ${entry.title}`,
      ...indentLines(entry.children, "    "),
      ...(picked !== undefined || withoutImages.has(entry)
        ? []
        : renderScreenshots(entry.images, entry.url, "    ")),
    ]),
    "  </details>",
  ];
}

const SECTIONS = [
  ["fork", "Fork changes and additions"],
  ["upstream", "Upstream changes and additions"],
  ["integration", "Integration of upstream and fork"],
] as const;

/**
 * The release notes from the changes and the agent's plan. The highlights of each section come
 * first. "## Full changelog" then lists every cluster with its changes folded. The desktop update
 * popover reads only the lines above "Full changelog" and drops `<details>` blocks, so it shows
 * the highlight lines. Over the size budget, the changes of the last clusters without picked
 * images lose their screenshots first.
 */
export function renderNotes(
  changes: DailyChanges,
  plan: NotesPlan,
  budget: number = NOTES_BUDGET,
): string {
  const clusters = {
    fork: resolveClusters("fork", plan.fork, [...changes.fork].map(forkEntry)),
    upstream: resolveClusters("upstream", plan.upstream, changes.upstream.map(upstreamEntry)),
    integration: resolveClusters(
      "integration",
      plan.integration,
      changes.integration.map(integrationEntry),
    ),
  };

  const render = (withoutImages: ReadonlySet<NoteEntry>) => {
    const highlights = SECTIONS.map(([key, title]) => {
      const shown = clusters[key].slice(0, plan[key].highlights ?? DEFAULT_HIGHLIGHTS);
      return [
        `## ${title}`,
        "",
        ...(shown.length > 0
          ? shown.flatMap((cluster) => [clusterHead(cluster), ...clusterScreenshots(cluster)])
          : ["- None."]),
      ].join("\n");
    });
    const full = SECTIONS.map(([key, title]) => {
      const count = clusters[key].reduce((total, cluster) => total + cluster.entries.length, 0);
      return [
        `### ${title} (${count} ${count === 1 ? "change" : "changes"})`,
        "",
        ...(clusters[key].length > 0
          ? clusters[key].flatMap((cluster) => renderCluster(cluster, withoutImages))
          : ["- None."]),
      ].join("\n");
    });
    return `${[
      plan.intro,
      ...highlights,
      "## Full changelog",
      ...(withoutImages.size > 0
        ? ["The last groups leave out their screenshots, because a release has a size limit."]
        : []),
      ...full,
    ].join("\n\n")}\n`;
  };

  const withoutImages = new Set<NoteEntry>();
  let text = render(withoutImages);
  const dropOrder = [...clusters.fork, ...clusters.upstream, ...clusters.integration]
    .filter((cluster) => cluster.picked === undefined)
    .flatMap((cluster) => cluster.entries)
    .filter((entry) => entry.images.length > 0)
    .toReversed();
  for (const entry of dropOrder) {
    if (text.length <= budget) return text;
    withoutImages.add(entry);
    text = render(withoutImages);
  }
  if (text.length > budget) {
    throw new Error(`The notes have ${text.length} characters, over the budget of ${budget}.`);
  }
  return text;
}

const FIELD = "\x1f";
const RECORD = "\x1e";

function run(command: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

const git = (args: ReadonlyArray<string>) => run("git", args);

function readCommits(args: ReadonlyArray<string>): GitCommit[] {
  return git([
    "log",
    `--format=%H${FIELD}%P${FIELD}%an${FIELD}%cI${FIELD}%s${FIELD}%b${RECORD}`,
    ...args,
  ])
    .split(RECORD)
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [sha, parents, author, committedAt, subject, body] = record.trimStart().split(FIELD);
      if (
        sha === undefined ||
        parents === undefined ||
        author === undefined ||
        committedAt === undefined
      ) {
        throw new Error(`Cannot read the git log record: ${record}`);
      }
      return {
        sha,
        parents: parents.split(" ").filter((parent) => parent !== ""),
        author,
        committedAt,
        subject: subject ?? "",
        body: body ?? "",
      };
    });
}

function isAncestor(ancestor: string, descendant: string): boolean {
  const result = NodeChildProcess.spawnSync("git", [
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    `git merge-base --is-ancestor ${ancestor} ${descendant} failed: ${result.stderr}`,
  );
}

/** Fetches a branch into FETCH_HEAD and returns its commit. */
function fetchBranch(remote: string, branch: string, tags: boolean): string {
  git(["fetch", "--quiet", tags ? "--tags" : "--no-tags", remote, branch]);
  return git(["rev-parse", "FETCH_HEAD"]).trim();
}

interface GitHubRelease {
  readonly tag_name: string;
  readonly html_url: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: ReadonlyArray<{ readonly name: string }>;
}

function isGitHubRelease(value: unknown): value is GitHubRelease {
  if (typeof value !== "object" || value === null) return false;
  const release = value as Record<string, unknown>;
  return (
    typeof release["tag_name"] === "string" &&
    typeof release["html_url"] === "string" &&
    typeof release["draft"] === "boolean" &&
    typeof release["prerelease"] === "boolean" &&
    Array.isArray(release["assets"])
  );
}

/** Newest created first, like the GitHub API. */
function readReleases(): GitHubRelease[] {
  const releases: unknown = JSON.parse(
    run("gh", ["api", `repos/${FORK_REPOSITORY}/releases?per_page=100`]),
  );
  if (!Array.isArray(releases) || !releases.every(isGitHubRelease)) {
    throw new Error("The GitHub releases response has an unexpected shape.");
  }
  return releases.filter((release) => !release.draft);
}

const PULL_REQUESTS_PER_QUERY = 100;

/** The bodies of pull requests, one GraphQL call per 100. A number that is an issue has none. */
function readPullRequestBodies(
  repository: string,
  numbers: ReadonlyArray<number>,
): Map<number, string> {
  const [owner, name] = repository.split("/");
  const bodies = new Map<number, string>();
  const unique = [...new Set(numbers)];
  for (let start = 0; start < unique.length; start += PULL_REQUESTS_PER_QUERY) {
    const chunk = unique.slice(start, start + PULL_REQUESTS_PER_QUERY);
    const fields = chunk
      .map(
        (number) =>
          `n${number}: issueOrPullRequest(number: ${number}) { ... on PullRequest { body } }`,
      )
      .join(" ");
    const response: unknown = JSON.parse(
      run("gh", [
        "api",
        "graphql",
        "-f",
        `query=query { repository(owner: "${owner}", name: "${name}") { ${fields} } }`,
      ]),
    );
    const found = (response as { data?: { repository?: Record<string, unknown> } }).data
      ?.repository;
    if (found === undefined) throw new Error(`No pull requests of ${repository} in the response.`);
    for (const number of chunk) {
      const body = (found[`n${number}`] as { body?: unknown } | null | undefined)?.body;
      if (typeof body === "string") bodies.set(number, body);
    }
  }
  return bodies;
}

/** Adds the images of each pull request body. Two GraphQL calls per 100 pull requests at most. */
/**
 * Images for fork changes without a pull request body, such as direct commits. The keys are refs:
 * `#123` or a full commit. A change in docs/fork/release-images.json goes through review, so a plan
 * still picks only images that a reviewed source names.
 */
export type ReleaseImages = ReadonlyMap<string, ReadonlyArray<PullRequestImage>>;

export function decodeReleaseImages(value: unknown): ReleaseImages {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("docs/fork/release-images.json must be an object of refs to image lists.");
  }
  return new Map(
    Object.entries(value).map(([ref, images]) => {
      const valid =
        Array.isArray(images) &&
        images.every(
          (image: unknown) =>
            typeof image === "object" &&
            image !== null &&
            typeof (image as { url?: unknown }).url === "string" &&
            (image as { url: string }).url.startsWith("https://") &&
            typeof (image as { alt?: unknown }).alt === "string",
        );
      if (!valid)
        throw new Error(`docs/fork/release-images.json: "${ref}" needs a list of {url, alt}.`);
      return [ref, images as ReadonlyArray<PullRequestImage>];
    }),
  );
}

/** Adds the images of the file to the fork changes that they name, after the body images. */
export function withReleaseImages<Change extends ForkChange>(
  change: Change,
  releaseImages: ReleaseImages,
): Change {
  const extra = releaseImages.get(forkChangeRef(change)) ?? [];
  const known = new Set(change.images.map((image) => image.url));
  const added = extra.filter((image) => !known.has(image.url));
  return added.length === 0 ? change : { ...change, images: [...change.images, ...added] };
}

function readReleaseImages(): ReleaseImages {
  const file = new URL("../docs/fork/release-images.json", import.meta.url);
  return decodeReleaseImages(JSON.parse(NodeFS.readFileSync(file, "utf8")));
}

function withImages(changes: DailyChanges): DailyChanges {
  const forkNumbers = [...changes.fork, ...changes.integration].flatMap((change) =>
    change.source._tag === "PullRequest" ? [change.source.number] : [],
  );
  const upstreamNumbers = changes.upstream.flatMap((change) =>
    change.pullRequest === null ? [] : [change.pullRequest.number],
  );
  const forkBodies = readPullRequestBodies(FORK_REPOSITORY, forkNumbers);
  const upstreamBodies = readPullRequestBodies(UPSTREAM_REPOSITORY, upstreamNumbers);
  const releaseImages = readReleaseImages();
  const forkImages = <Change extends ForkChange>(change: Change): Change =>
    withReleaseImages(
      change.source._tag === "PullRequest"
        ? { ...change, images: extractImages(forkBodies.get(change.source.number) ?? "") }
        : change,
      releaseImages,
    );
  return {
    fork: changes.fork.map(forkImages),
    integration: changes.integration.map(forkImages),
    upstream: changes.upstream.map((change) =>
      change.pullRequest === null
        ? change
        : { ...change, images: extractImages(upstreamBodies.get(change.pullRequest.number) ?? "") },
    ),
  };
}

const tagCommit = (tag: string) => git(["rev-parse", "--verify", `${tag}^{commit}`]).trim();

/** The parent of the oldest first-parent commit of fork main that upstream does not have. */
function findForkBase(main: string, upstream: string): string {
  const forkOnly = git(["rev-list", "--first-parent", main, "--not", upstream]).trim().split("\n");
  const oldest = forkOnly.at(-1);
  if (oldest === undefined || oldest === "")
    throw new Error("Fork main has no commits that upstream lacks.");
  return git(["rev-parse", `${oldest}^`]).trim();
}

function readFlag(args: ReadonlyArray<string>, name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

function main(args: ReadonlyArray<string>): void {
  const mainHead = fetchBranch(`https://github.com/${FORK_REPOSITORY}.git`, "main", true);
  const upstreamHead = fetchBranch(`https://github.com/${UPSTREAM_REPOSITORY}.git`, "main", false);
  const releases = readReleases();

  // The newest nightly first. Its build may still run: then it lacks SHA256SUMS, and an older one wins.
  const releaseFlag = readFlag(args, "--release");
  const targetIndex = releaseFlag
    ? releases.findIndex((release) => release.tag_name === releaseFlag)
    : releases.findIndex(
        (release) =>
          release.prerelease &&
          release.tag_name.includes("-nightly.") &&
          release.assets.some((asset) => asset.name === COMPLETE_RELEASE_ASSET) &&
          isAncestor(tagCommit(release.tag_name), mainHead),
      );
  if (releaseFlag && targetIndex === -1) throw new Error(`The fork has no release ${releaseFlag}.`);
  const target = releases[targetIndex];
  // Releases come newest first. Of a given release, the previous stable release comes after it.
  const previousStable = releases
    .slice(releaseFlag ? targetIndex + 1 : 0)
    .find((release) => !release.prerelease);
  const sinceFlag = readFlag(args, "--since");
  const since = sinceFlag
    ? {
        tag: null,
        ref: sinceFlag,
        sha: git(["rev-parse", "--verify", `${sinceFlag}^{commit}`]).trim(),
      }
    : previousStable
      ? {
          tag: previousStable.tag_name,
          ref: previousStable.tag_name,
          sha: tagCommit(previousStable.tag_name),
        }
      : { tag: null, ref: "fork base", sha: findForkBase(mainHead, upstreamHead) };
  const firstRelease = previousStable === undefined;

  const nightly =
    target === undefined ? undefined : { release: target, sha: tagCommit(target.tag_name) };

  if (nightly === undefined || isAncestor(nightly.sha, since.sha)) {
    process.stdout.write(
      `${JSON.stringify({ skip: `No complete nightly on main after ${since.tag ?? since.ref}.` }, null, 2)}\n`,
    );
    return;
  }

  const upstreamShas = new Set(
    git(["rev-list", upstreamHead, "--not", since.sha]).trim().split("\n"),
  );
  const changes = readCommits(["--first-parent", "--reverse", `${since.sha}..${nightly.sha}`]).map(
    (commit): FirstParentChange => {
      const [firstParent, secondParent] = commit.parents;
      if (firstParent === undefined || secondParent === undefined) {
        return { commit, brought: [], branchAuthor: undefined };
      }
      return {
        commit,
        brought: readCommits([commit.sha, "--not", firstParent, since.sha]).filter(
          (candidate) => candidate.sha !== commit.sha,
        ),
        branchAuthor: readCommits(["-1", secondParent])[0]?.author,
      };
    },
  );

  const grouped = withImages(
    groupDailyChanges(
      changes,
      (sha) => upstreamShas.has(sha),
      firstRelease && sinceFlag === undefined,
    ),
  );
  const planFile = readFlag(args, "--notes");
  if (planFile !== undefined) {
    const plan = decodeNotesPlan(JSON.parse(NodeFS.readFileSync(planFile, "utf8")));
    process.stdout.write(renderNotes(grouped, plan));
    return;
  }
  const data = {
    release: {
      tag: nightly.release.tag_name,
      url: nightly.release.html_url,
      sha: nightly.sha,
      isMainHead: nightly.sha === mainHead,
      mainHead,
    },
    since: { tag: since.tag, ref: since.ref, sha: since.sha },
    firstRelease,
    fork: grouped.fork.map((change) => ({ ref: forkChangeRef(change), ...change })),
    upstream: grouped.upstream.map((change) => ({ ref: upstreamChangeRef(change), ...change })),
    integration: grouped.integration.map((change) => ({ ref: forkChangeRef(change), ...change })),
  };
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message.trimEnd() : String(error)}\n`);
    process.exitCode = 1;
  }
}
