/** Fork: kitshn grants for tests: whether the map peer `PEER` may run commands here (K-722). */
import * as Effect from "effect/Effect";

import { PEER, SELF } from "../machineMap/MachineMap.testkit.ts";
import type * as KitshnGrants from "./KitshnGrants.ts";

/** The rules of `KitshnGrants` where `PEER` holds "runs commands" here, or not. */
export const fixedKitshnGrants = (peerMayExec: boolean) =>
  ({
    machine: Effect.succeed({ id: SELF, name: "Mac" }),
    machineMayExec: (machineId) => Effect.succeed(peerMayExec && machineId === PEER),
  }) as Pick<
    KitshnGrants.KitshnGrants["Service"],
    "machine" | "machineMayExec"
  > as KitshnGrants.KitshnGrants["Service"];
