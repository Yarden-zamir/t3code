import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as LocalDeviceHost from "./LocalDeviceHost.ts";

describe("Android SDK availability", () => {
  it.effect("finds the Homebrew SDK when the adb on PATH has no emulator", () =>
    Effect.gen(function* () {
      const root = "/opt/homebrew/share/android-commandlinetools";
      const cask = "/opt/homebrew/Caskroom/android-platform-tools/37.0.1";
      const sdk = yield* LocalDeviceHost.__testing.androidSdk.pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: "/test/home",
          PATH: "/opt/homebrew/bin",
        }),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: (file) =>
              Effect.succeed(
                [
                  "/opt/homebrew/bin/adb",
                  `${cask}/platform-tools/adb`,
                  `${root}/platform-tools/adb`,
                  `${root}/emulator/emulator`,
                  `${root}/cmdline-tools/latest/bin/avdmanager`,
                ].includes(file),
              ),
            realPath: () => Effect.succeed(`${cask}/platform-tools/adb`),
          }),
        ),
        Effect.provide(NodePath.layerPosix),
      );
      expect(sdk).toMatchObject({ root, emulator: true, avdmanager: true });
    }),
  );
});
