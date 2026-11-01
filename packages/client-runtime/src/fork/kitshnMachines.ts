/** Fork: the kitshn machine of each kitshn-joined environment, from its server config. */
import type { EnvironmentId, KitshnMachineRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import type { EnvironmentPresentation } from "../connection/presentation.ts";

const sameMachines = (
  left: ReadonlyMap<EnvironmentId, KitshnMachineRef>,
  right: ReadonlyMap<EnvironmentId, KitshnMachineRef>,
) =>
  left.size === right.size &&
  [...left].every(([environmentId, machine]) => {
    const other = right.get(environmentId);
    return other?.id === machine.id && other.name === machine.name;
  });

/** Environments without an entry are manual: the user added them by their address. */
export const makeKitshnMachineByIdAtom = (
  environmentIdsAtom: Atom.Atom<ReadonlyArray<EnvironmentId>>,
  presentationAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentPresentation | null>,
) =>
  Atom.make((get) => {
    const next = new Map(
      get(environmentIdsAtom).flatMap((environmentId) => {
        const machine = get(presentationAtom(environmentId))?.serverConfig?.kitshnMachine;
        return machine === undefined ? [] : [[environmentId, machine] as const];
      }),
    );
    const previous = Option.getOrNull(get.self<ReadonlyMap<EnvironmentId, KitshnMachineRef>>());
    return previous !== null && sameMachines(previous, next) ? previous : next;
  });
