import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, TERMINAL_THREAD_INSTANCE_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { machineRequestNamespace } from "./machineAccess.ts";
import { PEER, SELF, arrow, desiredState } from "./MachineMap.testkit.ts";
import * as MachineMapState from "./MachineMapState.ts";
import { refuseTerminalThreadWithoutExec } from "./terminalThreadExec.ts";

const terminal = { instanceId: TERMINAL_THREAD_INSTANCE_ID };
const fromPeer = machineRequestNamespace({ machineId: PEER, sessionId: "session-1" });
const withArrow = (exec: boolean) =>
  Effect.provideService(MachineMapState.MachineMapState, {
    activeDesired: Effect.succeed(
      desiredState({ arrowsIn: [arrow(PEER, SELF, "admin", { agentTools: true, exec })] }),
    ),
  } as unknown as MachineMapState.MachineMapState["Service"]);

it.effect("refuses a terminal thread to another machine whose arrow has no exec", () =>
  Effect.gen(function* () {
    const refused = yield* refuseTerminalThreadWithoutExec(fromPeer, terminal).pipe(
      withArrow(false),
      Effect.flip,
    );
    expect(refused.code).toBe("capability_denied");
    // Without the machine map, no arrow allows exec.
    expect(
      (yield* refuseTerminalThreadWithoutExec(fromPeer, terminal).pipe(Effect.flip)).code,
    ).toBe("capability_denied");
  }),
);

it.effect("allows it through an arrow with exec, and agent threads and local callers always", () =>
  Effect.gen(function* () {
    yield* refuseTerminalThreadWithoutExec(fromPeer, terminal).pipe(withArrow(true));
    yield* refuseTerminalThreadWithoutExec(fromPeer, {
      instanceId: ProviderInstanceId.make("codex"),
    }).pipe(withArrow(false));
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
    yield* refuseTerminalThreadWithoutExec(fromPeer, projectDefault).pipe(withArrow(true));
    expect(resolved).toBe(0);
    const refused = yield* refuseTerminalThreadWithoutExec(fromPeer, projectDefault).pipe(
      withArrow(false),
      Effect.flip,
    );
    expect(refused.code).toBe("capability_denied");
    expect(resolved).toBe(1);
  }),
);
