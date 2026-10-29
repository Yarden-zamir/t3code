/**
 * Fork: the `t3.agents` gate (K-706). While `kitshnAccessActive` holds, another machine needs the
 * level `use` for the forwarded agent tools and `exec` for `machine_exec`, on top of its arrow.
 */
import type { MachineDesiredState, MachineId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import { AGENTS_RESOURCE_ID, atLeast, type LevelOf } from "./kitshnGrantRules.ts";
import * as KitshnGrants from "./KitshnGrants.ts";

type AgentsLevel = LevelOf<"t3.agents">;

/** For a request of a machine session: its verified Access JWT names the caller. */
export const kitshnAgentsAllowRequest = (
  request: HttpServerRequest.HttpServerRequest,
  needed: AgentsLevel,
) =>
  Effect.serviceOption(KitshnGrants.KitshnGrants).pipe(
    Effect.flatMap((grants) =>
      Option.isNone(grants)
        ? Effect.succeed(true)
        : grants.value
            .visitor(request)
            .pipe(
              Effect.flatMap((visitor) =>
                visitor === null
                  ? Effect.succeed(true)
                  : grants.value
                      .level("t3.agents", AGENTS_RESOURCE_ID, visitor)
                      .pipe(Effect.map((level) => atLeast("t3.agents", level, needed))),
              ),
            ),
    ),
  );

/**
 * For a run that a machine session asked for, where the request is gone: the service token of
 * the peer is the `common_name` of the JWT that opened the session (MM-1305). Known limit: `ip`
 * rules do not match here, so an `exec` grant needs a `machine` rule. Revisit when the MCP scope
 * carries the visitor of its request.
 */
export const kitshnAgentsAllowMachine = (
  desired: MachineDesiredState,
  from: MachineId,
  needed: AgentsLevel,
) =>
  Effect.serviceOption(KitshnGrants.KitshnGrants).pipe(
    Effect.flatMap((grants) => {
      if (Option.isNone(grants)) return Effect.succeed(true);
      const peer = desired.peers.find((candidate) => candidate.id === from);
      return grants.value.active.pipe(
        Effect.flatMap((on) =>
          !on
            ? Effect.succeed(true)
            : peer === undefined
              ? Effect.succeed(false)
              : grants.value
                  .level("t3.agents", AGENTS_RESOURCE_ID, {
                    email: null,
                    clientId: peer.tokenClientId,
                    ip: null,
                  })
                  .pipe(Effect.map((level) => atLeast("t3.agents", level, needed))),
        ),
      );
    }),
  );
