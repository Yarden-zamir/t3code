/**
 * Fork: machine map (MM-1921). `t3 environment link`, `list` and `unlink` work on upstream's
 * table of manual links, which the fork never creates. Links come from the arrows, and the running
 * server knows them, so these commands refuse and say where the links are.
 */
import { PeerLinkError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PeerLinks from "../../peer/PeerLinks.ts";
import { MANUAL_LINK_REFUSAL } from "./machineAccess.ts";

const refused = (message: string) =>
  Effect.fail(new PeerLinkError({ reason: "incompatible", message }));

export const layer = Layer.succeed(
  PeerLinks.PeerLinks,
  PeerLinks.PeerLinks.of({
    link: Effect.fn("PeerLinks.link")(function () {
      return refused(MANUAL_LINK_REFUSAL);
    }),
    unlink: Effect.fn("PeerLinks.unlink")(function () {
      return refused(MANUAL_LINK_REFUSAL);
    }),
    list: refused(
      "Links to other machines come from the machine map. See them in Settings > Connections, or with t3_environment_links.",
    ),
    get: Effect.fn("PeerLinks.get")(function () {
      return refused(MANUAL_LINK_REFUSAL);
    }),
    resolve: Effect.fn("PeerLinks.resolve")(function () {
      return refused(MANUAL_LINK_REFUSAL);
    }),
    recordOutcome: Effect.fn("PeerLinks.recordOutcome")(function () {
      return Effect.void;
    }),
  }),
);
