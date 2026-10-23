// @effect-diagnostics nodeBuiltinImport:off - Node supplies glob matching for pnpm declarations; Effect Path has no glob matcher.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";

const decodeWorkspace = Schema.decodeUnknownEffect(
  fromYaml(Schema.Struct({ packages: Schema.Array(Schema.String) })),
);
const decodePackage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const excluded = new Set([
  ".git",
  ".repos",
  ".t3",
  "_shared",
  "node_modules",
  ".ssh",
  ".aws",
  "secrets",
  ".secrets",
  "userdata",
]);

export class WorkspaceDependencyInspectionError extends Schema.TaggedError<WorkspaceDependencyInspectionError>()(
  "WorkspaceDependencyInspectionError",
  {
    cwd: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return "Workspace dependency folders could not be inspected safely.";
  }
}
const isInspectionError = Schema.is(WorkspaceDependencyInspectionError);

export const makeWorkspaceDependencies = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return (cwd: string) =>
    Effect.gen(function* () {
      const root = yield* fs.realPath(cwd);
      const folders = new Set<string>();
      const packageExists = Effect.fn("ForkWorkspaceDependencies.packageExists")(function* (
        directory: string,
      ) {
        const file = path.join(directory, "package.json");
        if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option)))
          return yield* new WorkspaceDependencyInspectionError({ cwd });
        if (!(yield* fs.exists(file))) return false;
        yield* decodePackage(yield* fs.readFileString(file));
        return true;
      });
      if (yield* packageExists(root)) folders.add("node_modules");
      const manifest = path.join(root, "pnpm-workspace.yaml");
      if (Option.isSome(yield* fs.readLink(manifest).pipe(Effect.option)))
        return yield* new WorkspaceDependencyInspectionError({ cwd });
      if (!(yield* fs.exists(manifest))) return [...folders];
      const workspace = yield* decodeWorkspace(yield* fs.readFileString(manifest));
      const normalize = (pattern: string) => pattern.replace(/^\.\//, "").replace(/\/$/, "");
      const positive = workspace.packages
        .filter((pattern) => !pattern.startsWith("!"))
        .map(normalize);
      const negative = workspace.packages
        .filter((pattern) => pattern.startsWith("!"))
        .map((pattern) => normalize(pattern.slice(1)));
      if (
        workspace.packages.some((raw) => {
          const pattern = raw.replace(/^!/, "");
          return (
            path.isAbsolute(pattern) || pattern.split("/").includes("..") || pattern.includes("\\")
          );
        })
      )
        return yield* new WorkspaceDependencyInspectionError({ cwd });
      // Only workspace discovery expands pnpm declarations. Callers receive exact paths, never deletion globs.
      const couldContainPackage = (relative: string) =>
        positive.some((pattern) => {
          const segments = relative.split("/");
          const parts = pattern.split("/");
          const recursive = parts.indexOf("**");
          if (recursive === 0) return true;
          if (recursive >= 0 && segments.length > recursive)
            return NodePath.posix.matchesGlob(
              segments.slice(0, recursive).join("/"),
              parts.slice(0, recursive).join("/"),
            );
          return (
            segments.length <= parts.length &&
            NodePath.posix.matchesGlob(relative, parts.slice(0, segments.length).join("/"))
          );
        });
      const pending = [""];
      let visited = 0;
      while (pending.length > 0) {
        const relative = pending.pop()!;
        if (++visited > 2_000) return yield* new WorkspaceDependencyInspectionError({ cwd });
        const directory = path.join(root, relative);
        if (
          relative !== "" &&
          positive.some((pattern) => NodePath.posix.matchesGlob(relative, pattern)) &&
          !negative.some((pattern) => NodePath.posix.matchesGlob(relative, pattern)) &&
          (yield* packageExists(directory))
        )
          folders.add(`${relative}/node_modules`);
        for (const name of yield* fs.readDirectory(directory)) {
          if (excluded.has(name.toLowerCase()) || name.toLowerCase().startsWith(".env")) continue;
          const child = relative === "" ? name : `${relative}/${name}`;
          if (!couldContainPackage(child)) continue;
          const target = path.join(root, child);
          if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option)))
            return yield* new WorkspaceDependencyInspectionError({ cwd });
          if ((yield* fs.stat(target)).type !== "Directory") continue;
          if ((yield* fs.realPath(target)) !== target)
            return yield* new WorkspaceDependencyInspectionError({ cwd });
          pending.push(child);
        }
      }
      return [...folders].sort();
    }).pipe(
      Effect.mapError((cause) =>
        isInspectionError(cause) ? cause : new WorkspaceDependencyInspectionError({ cwd, cause }),
      ),
    );
});
