import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { readableThreadEnvironments } from "../composerThreadItems.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily, executeAtomQuery } from "./runtime.ts";

/**
 * Fork: MM-1906, MM-1907. The machines whose threads the agents of an environment can read, for the
 * `@` menu and the send check of web and mobile. The server probes each machine once and keeps its
 * environment id, so a minute of staleness is cheap.
 */
export function createReadableThreadEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const query = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:machine-map:readable-environments",
    tag: WS_METHODS.machineMapReadableEnvironments,
    staleTimeMs: 60_000,
    idleTtlMs: 120_000,
  });
  const readable = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      readableThreadEnvironments(
        environmentId,
        Option.getOrNull(AsyncResult.value(get(query({ environmentId, input: {} })))),
      ),
    ),
  );
  // An atom keeps one array while the answer stays the same, so hook dependencies stay stable.
  const readableIds = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(readable(environmentId)).map((entry) => entry.environmentId)),
  );
  /** The readable environment ids of each environment in a `\u0000`-joined key. */
  const readableIdsByEnvironment = Atom.family((key: string) =>
    Atom.make(
      (get): ReadonlyMap<EnvironmentId, ReadonlyArray<EnvironmentId>> =>
        new Map(
          (key === "" ? [] : (key.split("\u0000") as Array<EnvironmentId>)).map((environmentId) => [
            environmentId,
            get(readableIds(environmentId)),
          ]),
        ),
    ),
  );
  /**
   * `readableIds` after the server answered. Before the first answer, `readableIds` holds only the
   * environment itself, so a send with a thread of another machine waits for this instead. A
   * failed answer keeps that fallback, and the send check then reports the thread as unreadable.
   */
  const loadReadableIds = async (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
  ): Promise<ReadonlyArray<EnvironmentId>> => {
    await executeAtomQuery(registry, query({ environmentId, input: {} }), {
      label: "Read the machines whose threads this agent reads",
      reportFailure: false,
    });
    return registry.get(readableIds(environmentId));
  };
  return { readable, readableIds, readableIdsByEnvironment, loadReadableIds };
}
