import { expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  TERMINAL_THREAD_INSTANCE_ID,
  TERMINAL_THREADS_OFF_MESSAGE,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { refuseTerminalThreadWhileOff } from "./terminalThreadsOff.ts";

it.effect("refuses a terminal thread only while terminal threads are off", () =>
  Effect.gen(function* () {
    const off = ServerSettingsService.layerTest({ terminalThreads: false });
    const refused = yield* refuseTerminalThreadWhileOff(TERMINAL_THREAD_INSTANCE_ID).pipe(
      Effect.flip,
      Effect.provide(off),
    );
    expect(refused.message).toBe(TERMINAL_THREADS_OFF_MESSAGE);
    yield* refuseTerminalThreadWhileOff(ProviderInstanceId.make("claudeAgent")).pipe(
      Effect.provide(off),
    );
    yield* refuseTerminalThreadWhileOff(TERMINAL_THREAD_INSTANCE_ID).pipe(
      Effect.provide(ServerSettingsService.layerTest({ terminalThreads: true })),
    );
  }),
);
