/** Fork: the kitshn daemon release of each machine, from the kitshn `state` ask. */
import { KitshnDaemon } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as KitshnConnection from "./KitshnConnection.ts";
import * as KitshnGrants from "./KitshnGrants.ts";

// Other kinds and other fields stay out; an older kitshn sends no `daemon` key.
const StateCards = Schema.Struct({
  cards: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.String,
      daemon: Schema.optionalKey(Schema.NullOr(KitshnDaemon)),
    }),
  ),
});
const decodeStateCards = Schema.decodeUnknownEffect(StateCards);

/** The daemon of each machine card by machine id: null while it is offline or unknown. */
export const machineDaemons = Effect.fn("KitshnDaemon.machineDaemons")(function* (
  stateResult: unknown,
) {
  const { cards } = yield* decodeStateCards(stateResult);
  return new Map(
    cards.flatMap((card) =>
      card.kind === "machine" ? [[card.id, card.daemon ?? null] as const] : [],
    ),
  );
});

/**
 * The daemon of this machine, by the same `state` ask that `machines_read` sends. Null when this
 * server is not joined, kitshn does not answer, or kitshn shows the machine offline.
 */
export const ownDaemon = Effect.fn("KitshnDaemon.ownDaemon")(
  function* () {
    const grants = yield* Effect.serviceOption(KitshnGrants.KitshnGrants);
    const kitshn = yield* Effect.serviceOption(KitshnConnection.KitshnConnection);
    if (Option.isNone(grants) || Option.isNone(kitshn)) return null;
    const machine = yield* grants.value.machine;
    if (machine === null) return null;
    const answer = yield* kitshn.value.request({ type: "ask", action: "state", target: "" });
    if (!("result" in answer)) return null;
    return (yield* machineDaemons(answer.result)).get(machine.id) ?? null;
  },
  Effect.catch((error) =>
    Effect.logWarning("kitshn daemon: no state answer", { error: error.message }).pipe(
      Effect.as(null),
    ),
  ),
);
