import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  SourceControlProviderKind,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import type { ProviderChangeRequest } from "@t3tools/source-control-core/server/PullRequestProvider";
import type { SourceControlProvider } from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { fakePullRequestProvider } from "@t3tools/source-control-testing/fakeSourceControlDriver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as TestClock from "effect/testing/TestClock";

import * as PullRequestFilesViewed from "../persistence/PullRequestFilesViewed.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as PullRequestProviderRegistry from "./PullRequestProviderRegistry.ts";
import * as PullRequestReadCache from "./PullRequestReadCache.ts";
import * as PullRequestService from "./PullRequestService.ts";

const web: OrchestrationProjectShell = {
  id: "frontend" as ProjectId,
  title: "web",
  workspaceRoot: "/web",
  repositoryIdentity: {
    canonicalKey: "github.com/acme/web",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/web.git",
    },
    provider: SourceControlProviderKind.make("github"),
    displayName: "acme/web",
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

function changeRequest(number: number): ProviderChangeRequest {
  return {
    number,
    title: `Change request ${number}`,
    url: `https://github.com/acme/api/pull/${number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    headBranch: `feat/${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    reviewRequestLogins: [],
    labels: [],
  };
}

const makeService = (onListShells: () => void) =>
  Effect.flatMap(
    Layer.build(
      Layer.mergeAll(
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        Layer.succeed(
          PullRequestProviderRegistry.PullRequestProviderRegistry,
          PullRequestProviderRegistry.fromProviders([
            fakePullRequestProvider(SourceControlProviderKind.make("github"), {
              getChangeRequestSummary: (input) => Effect.succeed(changeRequest(input.number)),
            }),
          ]),
        ),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => undefined,
          resolveHandle: () => Effect.die("Unexpected provider refinement"),
          get: () => Effect.succeed({} as SourceControlProvider["Service"]),
        }),
        Layer.mock(ProjectService.ProjectService)({
          listShells: () => Effect.sync(onListShells).pipe(Effect.as([web])),
          getShell: (projectId) =>
            Effect.succeed(projectId === web.id ? Option.some(web) : Option.none()),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(null),
        }),
        SourceControlRateLimit.layer,
        PullRequestFilesViewed.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
        Layer.effect(PullRequestReadCache.PullRequestReadCache, PullRequestReadCache.make).pipe(
          Layer.provide(KeyValueStore.layerMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
    (context) => Effect.provideContext(PullRequestService.make, context),
  );

it.effect("lists the projects once for several reads of another repository in one sweep", () =>
  Effect.gen(function* () {
    let listings = 0;
    const service = yield* makeService(() => {
      listings += 1;
    });
    const read = (number: number) =>
      service.summary(
        { projectId: web.id, host: "github.com", repository: "acme/api", number },
        { recoverTransientFailure: false },
      );

    yield* Effect.all([read(1), read(2), read(3)], { concurrency: "unbounded" });
    yield* read(4);
    assert.strictEqual(listings, 1);

    // A project added later routes on the next sweep.
    yield* TestClock.adjust("1 minute");
    yield* read(5);
    assert.strictEqual(listings, 2);
  }),
);
