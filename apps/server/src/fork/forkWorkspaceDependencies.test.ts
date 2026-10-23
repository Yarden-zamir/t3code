import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  makeWorkspaceDependencies,
  WorkspaceDependencyInspectionError,
} from "./forkWorkspaceDependencies.ts";

it.effect("expands pnpm declarations to exact dependency paths, respecting exclusions", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const packageAt = (relative: string) =>
      fs
        .makeDirectory(path.join(root, relative), { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(path.join(root, relative, "package.json"), "{}")));
    yield* packageAt("");
    for (const relative of [
      "apps/web",
      "apps/private",
      "packages/contracts",
      "scripts",
      "other/unlisted",
    ])
      yield* packageAt(relative);
    yield* fs.writeFileString(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - ./apps/*\n  - packages/*\n  - scripts\n  - '!./apps/private'\n",
    );
    const inspect = yield* makeWorkspaceDependencies;
    assert.deepStrictEqual(yield* inspect(root), [
      "apps/web/node_modules",
      "node_modules",
      "packages/contracts/node_modules",
      "scripts/node_modules",
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does not follow linked workspace folders or guess an invalid declaration", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const outside = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(root, "apps"));
    yield* fs.writeFileString(path.join(outside, "package.json"), "{}");
    yield* fs.symlink(outside, path.join(root, "apps/linked"));
    yield* fs.writeFileString(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    const inspect = yield* makeWorkspaceDependencies;
    assert.instanceOf(yield* inspect(root).pipe(Effect.flip), WorkspaceDependencyInspectionError);
    assert.strictEqual(yield* fs.readFileString(path.join(outside, "package.json")), "{}");
    yield* fs.writeFileString(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - ../outside\n",
    );
    yield* inspect(root).pipe(Effect.flip);
  }).pipe(Effect.provide(NodeServices.layer)),
);
