/**
 * Fork: the `terminal` provider driver (default instance `terminal`). It has no CLI to probe, no
 * model catalog and no text generation. The server setting `terminalThreads` turns it on.
 */
import { type ServerProvider, type ServerSettings, TextGenerationError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";

import { resolveCompletionShell } from "../../project/ProjectSetupScriptRunner.ts";
import { makeTerminalAdapter, TERMINAL_DRIVER } from "./adapter.ts";
import { TerminalPort, unavailableTerminalPort } from "./port.ts";

const TerminalSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
type TerminalSettings = typeof TerminalSettings.Type;
const decodeTerminalSettings = Schema.decodeSync(TerminalSettings);

export type TerminalDriverEnv =
  | IdAllocator.IdAllocatorV2
  | ProviderHost.ProviderHost
  | Crypto.Crypto;

const noTextGeneration = (operation: string) => () =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "A terminal thread has no model.",
    }),
  );

const textGeneration: ProviderTextGeneration = {
  generateCommitMessage: noTextGeneration("generateCommitMessage"),
  generatePrContent: noTextGeneration("generatePrContent"),
  generateBranchName: noTextGeneration("generateBranchName"),
  generateThreadTitle: noTextGeneration("generateThreadTitle"),
  generateReviewGuide: noTextGeneration("generateReviewGuide"),
};

export const TerminalDriver: ProviderDriver<TerminalSettings, TerminalDriverEnv> = {
  driverKind: TERMINAL_DRIVER,
  metadata: { displayName: "Terminal", supportsMultipleInstances: false },
  configSchema: TerminalSettings,
  defaultConfig: () => decodeTerminalSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled }) =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const port = Option.getOrElse(
        yield* Effect.serviceOption(TerminalPort),
        () => unavailableTerminalPort,
      );
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const crypto = yield* Crypto.Crypto;
      const platform = yield* HostProcess.Platform;
      const environment = yield* HostProcess.Environment;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: TERMINAL_DRIVER,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: TERMINAL_DRIVER,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });

      // The instance shows as ready only while `terminalThreads` is on. It lists no model, so a
      // model picker has nothing to offer, and it has no text generation.
      const buildSnapshot = (settings: ServerSettings | null) =>
        DateTime.now.pipe(
          Effect.map((checkedAt) =>
            stampIdentity({
              ...buildServerProvider({
                presentation: {
                  displayName: "Terminal",
                  showInteractionModeToggle: false,
                  reportsContextWindow: false,
                  supportedRuntimeModes: ["full-access"],
                },
                enabled: enabled && settings?.terminalThreads === true,
                checkedAt: DateTime.formatIso(checkedAt),
                models: [],
                probe: {
                  installed: true,
                  version: null,
                  status: "ready",
                  auth: { status: "unknown" },
                },
              }),
              supportsTextGeneration: false,
            } as Omit<ServerProvider, "instanceId" | "driver">),
          ),
        );
      const readSnapshot = host.settings.get.pipe(
        Effect.flatMap(buildSnapshot),
        Effect.catch(() => buildSnapshot(null)),
      );
      const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
        provider: TERMINAL_DRIVER,
        packageName: null,
      });
      const snapshot: ManagedServerProvider = {
        resolveMaintenance: () => Effect.succeed(maintenance),
        getSnapshot: readSnapshot,
        refresh: readSnapshot,
        streamChanges: host.settings.changes.pipe(Stream.mapEffect(buildSnapshot)),
        applyUsageLimits: () => Effect.void,
      };

      const orchestrationAdapter = makeTerminalAdapter({
        instanceId,
        idAllocator,
        port,
        shell: resolveCompletionShell(platform, environment),
        newToken: crypto.randomUUIDv4().pipe(
          Effect.map((token) => token.replaceAll("-", "")),
          Effect.orDie,
        ),
        workspaceRootOf: port.workspaceRootOf,
        ensureEnabled: host.settings.get.pipe(
          Effect.mapError((error) => error.message),
          Effect.filterOrFail(
            (settings) => settings.terminalThreads,
            () => "Terminal threads are off. Turn on Settings > Fork > Terminal threads.",
          ),
          Effect.asVoid,
        ),
      });

      return {
        instanceId,
        driverKind: TERMINAL_DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: TERMINAL_DRIVER,
            instanceId,
            detail: "Failed to build the terminal provider.",
            cause,
          }),
      ),
    ),
};
