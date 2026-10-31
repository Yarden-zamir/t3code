import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, TERMINAL_THREAD_INSTANCE_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { machineRequestNamespace } from "./machineAccess.ts";
import * as KitshnGrants from "../kitshn/KitshnGrants.ts";
import { fixedKitshnGrants } from "../kitshn/KitshnGrants.testkit.ts";
import { PEER } from "./MachineMap.testkit.ts";
import { refuseTerminalThreadWithoutExec } from "./terminalThreadExec.ts";

const terminal = { instanceId: TERMINAL_THREAD_INSTANCE_ID };
const fromPeer = machineRequestNamespace({ machineId: PEER, sessionId: "session-1" });
const withGrants = (exec: boolean) =>
  Effect.provideService(KitshnGrants.KitshnGrants, fixedKitshnGrants(exec));

it.effect("refuses a terminal thread to another machine without runs commands", () =>
  Effect.gen(function* () {
    const refused = yield* refuseTerminalThreadWithoutExec(fromPeer, terminal).pipe(
      withGrants(false),
      Effect.flip,
    );
    expect(refused.code).toBe("capability_denied");
    // Without kitshn, nothing allows exec.
    expect(
      (yield* refuseTerminalThreadWithoutExec(fromPeer, terminal).pipe(Effect.flip)).code,
    ).toBe("capability_denied");
  }),
);

it.effect("allows it with runs commands, and agent threads and local callers always", () =>
  Effect.gen(function* () {
    yield* refuseTerminalThreadWithoutExec(fromPeer, terminal).pipe(withGrants(true));
    yield* refuseTerminalThreadWithoutExec(fromPeer, {
      instanceId: ProviderInstanceId.make("codex"),
    }).pipe(withGrants(false));
    yield* refuseTerminalThreadWithoutExec("thread:local", terminal);
  }),
);

it.effect("resolves a lazy model only for a machine session without exec", () =>
  Effect.gen(function* () {
    let resolved = 0;
    const projectDefault = Effect.sync(() => {
      resolved += 1;
      return terminal;
    });
    yield* refuseTerminalThreadWithoutExec("thread:local", projectDefault);
    yield* refuseTerminalThreadWithoutExec(fromPeer, projectDefault).pipe(withGrants(true));
    expect(resolved).toBe(0);
    const refused = yield* refuseTerminalThreadWithoutExec(fromPeer, projectDefault).pipe(
      withGrants(false),
      Effect.flip,
    );
    expect(refused.code).toBe("capability_denied");
    expect(resolved).toBe(1);
  }),
);
