import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopNetworkInterfaces from "./DesktopNetworkInterfaces.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

const encoder = new TextEncoder();

const emptyNetworkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces = {};

const layerMockSpawner = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() =>
    Effect.sync(() =>
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode("{}")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  ),
);

function layer(baseDir: string, networkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces) {
  const env = { T3CODE_HOME: baseDir };
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest(env))));
  const layerNetwork = Layer.succeed(DesktopNetworkInterfaces.DesktopNetworkInterfaces, {
    read: Effect.succeed(networkInterfaces),
  });

  return DesktopServerExposure.layer.pipe(
    Layer.provideMerge(DesktopAppSettings.layer),
    Layer.provideMerge(NodeFileSystem.layer),
    Layer.provideMerge(NodeHttpClient.layerUndici),
    Layer.provideMerge(layerMockSpawner),
    Layer.provideMerge(layerNetwork),
    Layer.provideMerge(DesktopConfig.layerTest(env)),
    Layer.provideMerge(layerEnvironment),
  );
}

const withHarness = <A, E, R>(
  networkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces,
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
    | DesktopServerExposure.DesktopServerExposure
    | DesktopAppSettings.DesktopAppSettings
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-server-exposure-test-",
    });
    return yield* effect.pipe(Effect.provide(layer(baseDir, networkInterfaces)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopServerExposure", () => {
  it.effect("keeps loopback and advertises the tunnel URL only while tunnel pairing is on", () =>
    withHarness(
      emptyNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.load;
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const invalid = yield* serverExposure
          .setTunnelPairing({
            enabled: true,
            url: "http://t3.example.com",
            trustedBrowserOrigins: null,
          })
          .pipe(Effect.flip);
        assert.equal(invalid._tag, "DesktopTunnelPairingInvalidUrlError");

        const enabled = yield* serverExposure.setTunnelPairing({
          enabled: true,
          url: "https://t3.example.com/",
          trustedBrowserOrigins: null,
        });
        assert.equal(enabled.requiresRelaunch, true);
        assert.equal(enabled.state.tunnelPairingUrl, "https://t3.example.com");

        const backendConfig = yield* serverExposure.backendConfig;
        assert.equal(backendConfig.bindHost, "127.0.0.1");
        assert.deepEqual(
          Option.getOrNull(backendConfig.tunnelPairingUrl),
          "https://t3.example.com",
        );
        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        const tunnelEndpoint = endpoints.find((endpoint) => endpoint.id.startsWith("tunnel:"));
        assert.equal(tunnelEndpoint?.httpBaseUrl.startsWith("https://t3.example.com"), true);
        assert.equal(tunnelEndpoint?.isDefault, true);
        // A pairing link must open this server's own page, not the hosted app.
        assert.notEqual(tunnelEndpoint?.compatibility.hostedHttpsApp, "compatible");

        const disabled = yield* serverExposure.setTunnelPairing({
          enabled: false,
          url: "https://t3.example.com",
          trustedBrowserOrigins: null,
        });
        assert.equal(disabled.requiresRelaunch, true);
        assert.isTrue(Option.isNone((yield* serverExposure.backendConfig).tunnelPairingUrl));
        // The URL stays saved for the next time pairing is turned on.
        assert.equal((yield* settings.get).tunnelPairingUrl, "https://t3.example.com");

        const badOrigins = yield* serverExposure
          .setTunnelPairing({
            enabled: true,
            url: "https://t3.example.com",
            trustedBrowserOrigins: "https://t3-vps.example.com, http://t3-win.example.com",
          })
          .pipe(Effect.flip);
        assert.equal(badOrigins._tag, "DesktopTunnelPairingInvalidUrlError");

        const trusted = yield* serverExposure.setTunnelPairing({
          enabled: true,
          url: "https://t3.example.com",
          trustedBrowserOrigins: "https://t3-vps.example.com/\nhttps://t3-win.example.com",
        });
        assert.equal(trusted.requiresRelaunch, true);
        assert.equal(
          Option.getOrNull((yield* serverExposure.backendConfig).trustedBrowserOrigins),
          "https://t3-vps.example.com,https://t3-win.example.com",
        );
      }),
    ),
  );
});
