import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, ...args],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

it.layer(NodeServices.layer)("RepositoryIdentityResolverLive", (it) => {
  it.effect("names a fork checkout by its origin while preferOriginRemote is on", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-prefer-origin-test-",
      });
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code-fork.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/t3code.git"]);

      let preferOrigin = true;
      const resolver = yield* RepositoryIdentityResolver.make({
        preferOriginRemote: Effect.sync(() => preferOrigin),
      }).pipe(Effect.provide(ProcessRunner.layer));

      const fork = yield* resolver.resolve(cwd);
      expect(fork?.canonicalKey).toBe("github.com/julius/t3code-fork");
      expect(fork?.locator.remoteName).toBe("origin");
      expect(fork?.origin).toBeUndefined();

      // Turning the setting off takes effect without a refresh.
      preferOrigin = false;
      expect((yield* resolver.resolve(cwd))?.canonicalKey).toBe("github.com/t3tools/t3code");
    }),
  );
});
