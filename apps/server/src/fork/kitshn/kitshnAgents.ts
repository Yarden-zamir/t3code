/**
 * Fork: what another machine may do on this one (K-706). Its `t3.app` grant gives its session,
 * `t3.agents` = `use` the forwarded agent tools, and `exec` plus `t3.app` at `standard` or higher
 * `machine_exec` and terminal threads. A machine is named by the `machine` rule of its token.
 */
import {
  AuthOrchestrationOperateScope,
  type AuthEnvironmentScope,
  MACHINE_LEVEL_LINK_ACCESS,
  MachineId,
  machineSessionSubject,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import {
  AGENTS_RESOURCE_ID,
  APP_RESOURCE_ID,
  type AccessVisitor,
  atLeast,
  type LevelOf,
  machineIdOfToken,
  tokenOfMachine,
} from "./kitshnGrantRules.ts";
import * as KitshnGrants from "./KitshnGrants.ts";

type AgentsLevel = LevelOf<"t3.agents">;

const allows = (
  grants: KitshnGrants.KitshnGrants["Service"],
  visitor: AccessVisitor,
  needed: AgentsLevel,
) =>
  Effect.all([
    grants.level("t3.agents", AGENTS_RESOURCE_ID, visitor),
    grants.level("t3.app", APP_RESOURCE_ID, visitor),
  ]).pipe(
    Effect.map(
      ([agents, app]) =>
        atLeast("t3.agents", agents, needed) &&
        (needed === "exec" ? atLeast("t3.app", app, "standard") : app !== null),
    ),
  );

/** The machine of a service token, for the subject of its session; null for any other visitor. */
export const kitshnMachineOf = (visitor: AccessVisitor) =>
  Effect.serviceOption(KitshnGrants.KitshnGrants).pipe(
    Effect.flatMap((grants) =>
      Option.isNone(grants) || visitor.clientId === null
        ? Effect.succeed(null)
        : grants.value.state.pipe(
            Effect.map((state) => {
              const machineId = machineIdOfToken(state.tables, visitor.clientId!);
              return machineId === null ? null : MachineId.make(machineId);
            }),
          ),
    ),
  );

/**
 * For a run that a machine session asked for, after its request: the token of the machine's
 * `machine` rule stands for it. Known limit: `ip` rules do not count here. Revisit when the MCP
 * scope carries the visitor of its request.
 */
export const kitshnMachineAllows = (from: MachineId, needed: AgentsLevel) =>
  Effect.serviceOption(KitshnGrants.KitshnGrants).pipe(
    Effect.flatMap((grants) => {
      if (Option.isNone(grants)) return Effect.succeed(false);
      return grants.value.state.pipe(
        Effect.flatMap((state) => {
          const clientId = tokenOfMachine(state.tables, from);
          return clientId === null
            ? Effect.succeed(false)
            : allows(grants.value, { email: null, clientId, ip: null }, needed);
        }),
      );
    }),
  );

/**
 * MM-1307 on grants: the MCP client of a machine session whose token holds `t3.agents` = `use`,
 * with the link access of its `t3.app` level. Bearer tokens only, and only with the JWT of the
 * same machine.
 */
export const kitshnMachineMcpClient = Effect.fn("kitshnMachineMcpClient")(function* (
  request: HttpServerRequest.HttpServerRequest,
  session: {
    readonly subject: string;
    readonly method: string;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  },
) {
  const grants = yield* Effect.serviceOption(KitshnGrants.KitshnGrants);
  if (Option.isNone(grants) || session.method !== "bearer-access-token") return undefined;
  const visitor = yield* grants.value.visitor(request);
  if (visitor === null) return undefined;
  const machineId = yield* kitshnMachineOf(visitor);
  if (machineId === null || session.subject !== machineSessionSubject(machineId)) {
    return undefined;
  }
  if (!(yield* allows(grants.value, visitor, "use"))) return undefined;
  const app = yield* grants.value.level("t3.app", APP_RESOURCE_ID, visitor);
  if (app === null) return undefined;
  return {
    sessionId: machineSessionSubject(machineId),
    label: `machine ${machineId}`,
    access: session.scopes.includes(AuthOrchestrationOperateScope)
      ? MACHINE_LEVEL_LINK_ACCESS[app]
      : ("read-only" as const),
    peerLink: true as const,
    machineId,
  };
});
