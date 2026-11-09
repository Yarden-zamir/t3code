/**
 * Fork changelog contract, behind the `forkChangelogEnabled` client setting. The server reads from
 * GitHub the fork releases, their commits, the upstream commits that fork main lacks, and the open
 * pull request of the merge agent. A fork commit is a commit that upstream main does not contain.
 * @module forkChangelog
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The GitHub repositories (`owner/name`) that the fork changelog reads. */
export const FORK_CHANGELOG_REPOSITORIES = {
  fork: "Yarden-zamir/t3code",
  upstream: "pingdotgg/t3code",
} as const;

export const ForkCommit = Schema.Struct({
  sha: TrimmedNonEmptyString,
  /** The first line of the commit message. */
  subject: Schema.String,
  /** True when upstream main does not contain the commit. Then `#123` in the subject is a fork pull request. */
  fork: Schema.Boolean,
  author: Schema.NullOr(Schema.String),
  /** The GitHub account of the author. Null when GitHub cannot match the commit email to an account. */
  authorLogin: Schema.NullOr(Schema.String),
  committedAt: Schema.NullOr(Schema.String),
  url: Schema.String,
});
export type ForkCommit = typeof ForkCommit.Type;

export const ForkRelease = Schema.Struct({
  tag: TrimmedNonEmptyString,
  /** The tag without its leading `v`, in the app version format. */
  version: TrimmedNonEmptyString,
  name: Schema.String,
  publishedAt: Schema.NullOr(Schema.String),
  url: Schema.String,
});
export type ForkRelease = typeof ForkRelease.Type;

/** Newest version first. */
export const ForkReleaseList = Schema.Struct({
  releases: Schema.Array(ForkRelease),
});
export type ForkReleaseList = typeof ForkReleaseList.Type;

export const ForkReleaseChangesInput = Schema.Struct({
  tag: TrimmedNonEmptyString,
});
export type ForkReleaseChangesInput = typeof ForkReleaseChangesInput.Type;

/** The commits a release adds to the release before it. Merge commits are left out. */
export const ForkReleaseChanges = Schema.Struct({
  tag: TrimmedNonEmptyString,
  /** Null for the oldest listed release. Then `commits` holds only the fork commits it has. */
  previousTag: Schema.NullOr(TrimmedNonEmptyString),
  /** Fork and upstream commits in one list, newest first. */
  commits: Schema.Array(ForkCommit),
  /** GitHub held more commits than the server reads. */
  truncated: Schema.Boolean,
  compareUrl: Schema.NullOr(Schema.String),
});
export type ForkReleaseChanges = typeof ForkReleaseChanges.Type;

export const ForkWorkflowState = Schema.Literals([
  "queued",
  "running",
  "success",
  "failure",
  "cancelled",
  "skipped",
]);
export type ForkWorkflowState = typeof ForkWorkflowState.Type;

/** The title of the pull request that the merge agent opens. See docs/fork-agents.md "Merge agent". */
export const FORK_SYNC_PULL_REQUEST_TITLE = "chore(sync): merge pingdotgg/t3code main";

/** The open pull request of the merge agent. */
export const ForkSyncPullRequest = Schema.Struct({
  number: NonNegativeInt,
  title: Schema.String,
  url: Schema.String,
  draft: Schema.Boolean,
  /** The newest Fork CI run on the head commit. Null until Fork CI starts on it. */
  checks: Schema.NullOr(ForkWorkflowState),
});
export type ForkSyncPullRequest = typeof ForkSyncPullRequest.Type;

/** Upstream main commits that fork main does not have yet, newest first. */
export const ForkUpstreamPending = Schema.Struct({
  commits: Schema.Array(ForkCommit),
  total: NonNegativeInt,
  truncated: Schema.Boolean,
  compareUrl: Schema.String,
  /** Null when no merge agent pull request is open. */
  syncPullRequest: Schema.NullOr(ForkSyncPullRequest),
});
export type ForkUpstreamPending = typeof ForkUpstreamPending.Type;

export class ForkChangelogError extends Schema.TaggedError<ForkChangelogError>()(
  "ForkChangelogError",
  {
    operation: Schema.String,
    /** A message safe to show, such as GitHub's refusal. Never a token. */
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Fork changelog (${this.operation}): ${this.detail}`;
  }
}
