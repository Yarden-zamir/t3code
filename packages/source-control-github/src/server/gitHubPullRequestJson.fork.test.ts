import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  reviewThreadConversation,
  toPullRequestActivityPage,
  toReviewThreadCommentsPage,
  toReviewThreadPage,
} from "./gitHubPullRequestJson.ts";
import { PullRequestActivity } from "./pullRequestReads.graphql.ts";
import { ReviewThreadComments, ReviewThreads } from "./pullRequestReviews.graphql.ts";

const through =
  <S extends Schema.Codec<unknown, unknown>, A>(schema: S, map: (result: S["Type"]) => A | null) =>
  (raw: string): Result.Result<A, unknown> => {
    const decoded = Schema.decodeUnknownResult(schema)(
      (JSON.parse(raw) as { readonly data: unknown }).data,
    );
    if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
    const mapped = map(decoded.success);
    return mapped === null ? Result.fail("not found") : Result.succeed(mapped);
  };

// Fixtures are loose JSON on purpose: each one writes only the fields its test is about.
type Json = Record<string, any>;
const LAST_PAGE = { hasNextPage: false, endCursor: null };
const remark = ({ author, ...raw }: Json) => ({
  body: "",
  lastEditedAt: null,
  authorAssociation: "NONE",
  url: "https://github.com/acme/web/pull/1#discussion",
  ...raw,
  author:
    author === null || author === undefined
      ? null
      : { __typename: "User", avatarUrl: "", ...author },
  reactionGroups: [],
});
const threadCommentsOf = ({ nodes, ...connection }: Json) => ({
  totalCount: (nodes ?? []).length,
  pageInfo: LAST_PAGE,
  ...connection,
  nodes: (nodes ?? []).map(remark),
});
const withReviewDefaults = (raw: string): string => {
  const { data } = JSON.parse(raw) as { data: Json };
  const pr = data["repository"]["pullRequest"];
  if (pr["reviewThreads"] !== undefined) {
    const { reviewThreads, ...rest } = pr;
    data["repository"]["pullRequest"] = {
      viewerCanUpdate: true,
      viewerDidAuthor: false,
      reviewDismissals: { pageInfo: LAST_PAGE, nodes: [] },
      reactionGroups: [],
      reviews: { nodes: [] },
      commits: { nodes: [] },
      ...rest,
      reviewThreads: {
        pageInfo: LAST_PAGE,
        ...reviewThreads,
        nodes: (reviewThreads["nodes"] as ReadonlyArray<Json>).map((thread) => ({
          isResolved: false,
          isOutdated: false,
          line: null,
          diffSide: "RIGHT",
          ...thread,
          comments: threadCommentsOf(thread["comments"]),
        })),
      },
    };
  }
  if (data["node"] !== undefined && data["node"] !== null) {
    data["node"] = {
      __typename: "PullRequestReviewThread",
      ...data["node"],
      comments: threadCommentsOf(data["node"]["comments"]),
    };
  }
  data["viewer"] ??= { login: "viewer" };
  return JSON.stringify({ data });
};
const decodePullRequestActivityJson = through(
  PullRequestActivity.result,
  toPullRequestActivityPage,
);
const decodeReviewThreadsJson = (raw: string) =>
  through(ReviewThreads.result, toReviewThreadPage)(withReviewDefaults(raw));
const decodeReviewThreadCommentsJson = (raw: string) =>
  through(ReviewThreadComments.result, toReviewThreadCommentsPage)(withReviewDefaults(raw));

function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

describe("pull request detail decoding", () => {
  const activityJson = (raw: Record<string, unknown>) =>
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            author: null,
            comments: {
              pageInfo: LAST_PAGE,
              nodes: ((raw["comments"] ?? []) as ReadonlyArray<Record<string, unknown>>).map(
                (comment) => ({
                  lastEditedAt: null,
                  authorAssociation: "NONE",
                  url: "https://github.com/c",
                  author: null,
                  ...comment,
                }),
              ),
            },
            reviews: {
              pageInfo: LAST_PAGE,
              nodes: ((raw["reviews"] ?? []) as ReadonlyArray<Record<string, unknown>>).map(
                (review) => ({
                  lastEditedAt: null,
                  authorAssociation: "NONE",
                  url: "https://github.com/r",
                  author: null,
                  submittedAt: null,
                  ...review,
                }),
              ),
            },
            commits: { nodes: [] },
          },
        },
      },
    });
  const activity = (raw: Record<string, unknown>) =>
    Result.map(decodePullRequestActivityJson(activityJson(raw)), (page) => ({
      comments: page.remarks.toSorted((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
    }));

  it("carries each remark author's repository role in upper case", () => {
    const detail = expectSuccess(
      activity({
        comments: [
          { id: "c1", body: "hi", createdAt: "2026-07-04T00:00:00Z", authorAssociation: "MEMBER" },
          { id: "c2", body: "hey", createdAt: "2026-07-05T00:00:00Z" },
        ],
        reviews: [
          {
            id: "r1",
            body: "ok",
            state: "APPROVED",
            submittedAt: "2026-07-06T00:00:00Z",
            authorAssociation: "owner",
          },
        ],
      }),
    );
    expect(detail.comments.map((comment) => [comment.id, comment.authorAssociation])).toEqual([
      ["c1", "MEMBER"],
      ["c2", "NONE"],
      ["r1", "OWNER"],
    ]);
  });
});

describe("review thread decoding", () => {
  const threadsJson = (
    nodes: ReadonlyArray<Record<string, unknown>>,
    pullRequest: Record<string, unknown> = {},
  ) =>
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { totalCount: nodes.length, nodes },
            author: null,
            comments: { nodes: [] },
            reviewRequests: { nodes: [] },
            latestReviews: { nodes: [] },
            ...pullRequest,
          },
        },
      },
    });

  const comment = (id: string, body: string) => ({
    id,
    author: { login: "bilal", avatarUrl: "https://avatars/b.png" },
    body,
    createdAt: "2026-07-01T00:00:00Z",
    url: `https://github.com/acme/web/pull/1#discussion_r${id}`,
  });

  it("carries a thread comment author's repository role into the conversation", () => {
    const reviewThreads = expectSuccess(
      decodeReviewThreadsJson(
        threadsJson([
          {
            id: "PRRT_1",
            path: "src/a.ts",
            line: 1,
            comments: {
              totalCount: 2,
              nodes: [
                { ...comment("c1", "first"), authorAssociation: "COLLABORATOR" },
                comment("c2", "second"),
              ],
            },
          },
        ]),
      ),
    );
    const conversation = reviewThreadConversation(
      reviewThreads.threads.map((entry) => entry.thread),
    );
    expect(conversation.map((remark) => remark.authorAssociation)).toEqual([
      "COLLABORATOR",
      "NONE",
    ]);
    const page = expectSuccess(
      decodeReviewThreadCommentsJson(
        JSON.stringify({
          data: {
            repository: { pullRequest: { id: "PR_1" } },
            node: {
              pullRequest: { id: "PR_1" },
              comments: { nodes: [{ ...comment("c3", "third"), authorAssociation: "NONE" }] },
            },
          },
        }),
      ),
    );
    expect(page.comments[0]?.authorAssociation).toBe("NONE");
  });
});
