/** Fork: kitshn grant test data: the grants of the map peer `PEER` on this machine. */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { PEER, PEER_TOKEN, SELF } from "../machineMap/MachineMap.testkit.ts";
import { type GrantState, levelFor } from "./kitshnGrantRules.ts";
import type * as KitshnGrants from "./KitshnGrants.ts";

/** `PEER`'s token holds `t3.app` and `t3.agents` at these levels; null is no grant. */
export const peerGrants = (app: string | null, agents: string | null): GrantState => {
  const rule = { machine: { machineId: PEER, clientId: PEER_TOKEN } };
  const grant = (level: string) => ({
    circle: {
      id: "c",
      name: "Machines",
      match: "any" as const,
      needsPasskey: false,
      rules: [rule],
    },
    level,
    endsAt: null,
  });
  return {
    tables: {
      ...(app === null ? {} : { app: [grant(app)] }),
      ...(agents === null ? {} : { agents: [grant(agents)] }),
    },
    lastContactAt: 0,
  };
};

/** The rules of `KitshnGrants` on a table that the test changes; it never goes stale. */
export const fakeKitshnGrants = (state: SubscriptionRef.SubscriptionRef<GrantState>) =>
  ({
    state: SubscriptionRef.get(state),
    machine: Effect.succeed({ id: SELF, name: "Mac" }),
    level: (kind, resourceId, visitor) =>
      Effect.map(SubscriptionRef.get(state), (current) =>
        levelFor(current, kind, resourceId, visitor, current.lastContactAt ?? 0),
      ),
    awaitLoss: (allowed) =>
      SubscriptionRef.changes(state).pipe(
        Stream.mapEffect(() => allowed),
        Stream.filter((stillAllowed) => !stillAllowed),
        Stream.runHead,
        Effect.asVoid,
      ),
  }) as Pick<
    KitshnGrants.KitshnGrants["Service"],
    "state" | "machine" | "level" | "awaitLoss"
  > as KitshnGrants.KitshnGrants["Service"];

/** The rules of `KitshnGrants` on a table that never changes. */
export const fixedKitshnGrants = (grants: GrantState) =>
  ({
    state: Effect.succeed(grants),
    machine: Effect.succeed({ id: SELF, name: "Mac" }),
    level: (kind, resourceId, visitor) =>
      Effect.succeed(levelFor(grants, kind, resourceId, visitor, grants.lastContactAt ?? 0)),
    awaitLoss: () => Effect.never,
  }) as Pick<
    KitshnGrants.KitshnGrants["Service"],
    "state" | "machine" | "level" | "awaitLoss"
  > as KitshnGrants.KitshnGrants["Service"];
