/**
 * Fork: the `terminal` provider driver (default instance `terminal`). It has no CLI to probe and
 * no text generation, and its models are the shells of the server. The server setting
 * `terminalThreads` turns it on.
 */
import {
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
  TERMINAL_THREAD_MODEL_SELECTION,
  TERMINAL_THREADS_OFF_MESSAGE,
  type TerminalCustomShell,
  TextGenerationError,
} from "@t3tools/contracts";
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
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  customShellProblem,
  type TerminalShell,
  TerminalShellSettings,
  terminalShells,
} from "../terminalShells.ts";
import { makeTerminalAdapter, TERMINAL_DRIVER } from "./adapter.ts";
import { TerminalPort, unavailableTerminalPort } from "./port.ts";

const TerminalSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  ...TerminalShellSettings.fields,
});
type TerminalSettings = typeof TerminalSettings.Type;
const decodeTerminalSettings = Schema.decodeSync(TerminalSettings);

export type TerminalDriverEnv = IdAllocator.IdAllocatorV2 | ProviderHost.ProviderHost;

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

/**
 * One model for each shell, the default shell first and the custom shells after the detected
 * ones. The path or the command line shows next to the name, and a custom shell that cannot start
 * says why. The legacy model `terminal` stays listed for the threads, schedules and agents that
 * name it.
 */
function terminalShellModels(
  shells: ReadonlyArray<TerminalShell>,
  customShells: ReadonlyArray<{
    readonly shell: TerminalCustomShell;
    readonly problem: string | undefined;
  }>,
): ReadonlyArray<ServerProviderModel> {
  return [
    ...shells.map((shell, index) => ({
      slug: shell.name,
      name: shell.name,
      subProvider: shell.path,
      isCustom: false,
      isDefault: index === 0,
      capabilities: null,
    })),
    ...customShells.map(({ shell, problem }) => ({
      slug: shell.name,
      name: shell.name,
      subProvider: [shell.executable, ...shell.args].join(" "),
      isCustom: true,
      ...(problem === undefined ? {} : { unavailableReason: problem }),
      capabilities: null,
    })),
    {
      slug: TERMINAL_THREAD_MODEL_SELECTION.model,
      name: "Default shell",
      isCustom: false,
      isLegacy: true,
      capabilities: null,
    },
  ];
}

export const TerminalDriver: ProviderDriver<TerminalSettings, TerminalDriverEnv> = {
  driverKind: TERMINAL_DRIVER,
  metadata: { displayName: "Terminal", supportsMultipleInstances: false },
  configSchema: TerminalSettings,
  defaultConfig: () => decodeTerminalSettings({}),
  create: Effect.fn("TerminalProviderDriver.create")(
    function* ({ instanceId, displayName, accentColor, enabled, config }) {
      const host = yield* ProviderHost.ProviderHost;
      const port = Option.getOrElse(
        yield* Effect.serviceOption(TerminalPort),
        () => unavailableTerminalPort,
      );
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
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

      const shells = yield* terminalShells;
      const platform = yield* HostProcess.Platform;
      const env = yield* HostProcess.Environment;
      // Each snapshot checks the custom shells again, so an executable that the user installs
      // shows as found at the next refresh.
      const readModels = Effect.forEach(config.customShells, (shell) =>
        customShellProblem(shell, { platform, env }).pipe(
          Effect.map((problem) => ({ shell, problem })),
        ),
      ).pipe(Effect.map((customShells) => terminalShellModels(shells, customShells)));
      // The instance shows as ready only while `terminalThreads` is on.
      const buildSnapshot = (settings: ServerSettings | null) =>
        Effect.all([DateTime.now, readModels]).pipe(
          Effect.map(([checkedAt, models]) =>
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
                models,
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
        workspaceRootOf: port.workspaceRootOf,
        ensureEnabled: host.settings.get.pipe(
          Effect.mapError((error) => error.message),
          Effect.filterOrFail(
            (settings) => settings.terminalThreads,
            () => TERMINAL_THREADS_OFF_MESSAGE,
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
    },
    (effect, { instanceId }) =>
      effect.pipe(
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
  ),
};
