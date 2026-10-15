/**
 * Fork, experimental: a CPU cap for agents and terminals (setting `forkAgentCpuQuotaPercent`).
 *
 * Upstream already starts each agent and terminal in a transient scope in the slice
 * `AGENT_SLICE` of the systemd user manager (`process/agentScope.ts`). This sets `CPUQuota` on
 * that slice, so all agents together get at most that share of the CPU. The server keeps the
 * rest. On macOS, Windows, and Linux without a user manager, it does nothing.
 *
 * The cap is a runtime property: it lasts until the next reboot. A server that starts with the
 * setting off does not clear a cap that an earlier server set. Revisit if the setting is turned
 * off while the server is down and the cap must go before a reboot.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { AGENT_SLICE } from "../process/agentScope.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";

/** The `systemctl` value of a cap. An empty `CPUQuota=` removes the cap. */
const cpuQuotaProperty = (percent: number | null): string =>
  percent === null ? "CPUQuota=" : `CPUQuota=${percent}%`;

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  // Without XDG_RUNTIME_DIR, `systemctl --user` cannot reach the user manager, and agentScope
  // starts agents without scopes, so no slice holds them.
  if (platform !== "linux" || !environment.XDG_RUNTIME_DIR) return;
  const settings = yield* ServerSettings.ServerSettingsService;
  const runner = yield* ProcessRunner.ProcessRunner;

  const apply = (percent: number | null) =>
    runner
      .run({
        command: "systemctl",
        args: ["--user", "set-property", "--runtime", AGENT_SLICE, cpuQuotaProperty(percent)],
        timeout: "5 seconds",
      })
      .pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.logInfo("Agent CPU cap set", { slice: AGENT_SLICE, percent })
            : Effect.logWarning("Could not set the agent CPU cap", {
                slice: AGENT_SLICE,
                percent,
                stderr: result.stderr.trim(),
              }),
        ),
        Effect.catch((error) => Effect.logWarning("Could not set the agent CPU cap", { error })),
      );

  const changes = yield* settings.subscribeChanges;
  const initial = yield* settings.getSettings.pipe(Effect.option);
  const start = initial._tag === "Some" ? initial.value.forkAgentCpuQuotaPercent : null;
  if (start !== null) yield* apply(start);
  // Each change of the setting after the start applies once.
  yield* Stream.succeed(start).pipe(
    Stream.concat(Stream.map(changes, (next) => next.forkAgentCpuQuotaPercent)),
    Stream.changes,
    Stream.drop(1),
    Stream.runForEach(apply),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make);
