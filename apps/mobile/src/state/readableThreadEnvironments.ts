import { useAtomValue } from "@effect/atom-react";
import type { ReadableThreadEnvironment } from "@t3tools/client-runtime/composerThreadItems";
import { createReadableThreadEnvironmentAtoms } from "@t3tools/client-runtime/state/readableThreadEnvironments";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";

const readableThreadEnvironmentAtoms = createReadableThreadEnvironmentAtoms(connectionAtomRuntime);

const NO_READABLE_ENVIRONMENTS = Atom.make<ReadonlyArray<ReadableThreadEnvironment>>([]);
const NO_READABLE_ENVIRONMENT_IDS = Atom.make<ReadonlyArray<EnvironmentId>>([]);

/**
 * Fork: MM-1906, MM-1907. The composer's environment first, then the machines whose threads its
 * agent reads through the machine map. Empty without an environment.
 */
export function useReadableThreadEnvironments(
  environmentId: EnvironmentId | null,
): ReadonlyArray<ReadableThreadEnvironment> {
  return useAtomValue(
    environmentId === null
      ? NO_READABLE_ENVIRONMENTS
      : readableThreadEnvironmentAtoms.readable(environmentId),
  );
}

/** The environment ids of `useReadableThreadEnvironments`. */
export function useReadableThreadEnvironmentIds(
  environmentId: EnvironmentId | null,
): ReadonlyArray<EnvironmentId> {
  return useAtomValue(
    environmentId === null
      ? NO_READABLE_ENVIRONMENT_IDS
      : readableThreadEnvironmentAtoms.readableIds(environmentId),
  );
}

/**
 * MM-1906: the ids of `useReadableThreadEnvironmentIds` now. A send reads them at call time, so
 * it sees the answer that `loadReadableThreadEnvironmentIds` waited for.
 */
export const currentReadableThreadEnvironmentIds = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(readableThreadEnvironmentAtoms.readableIds(environmentId));

/** MM-1906: the readable environment ids of `environmentId` once its server answered. */
export const loadReadableThreadEnvironmentIds = (environmentId: EnvironmentId) =>
  readableThreadEnvironmentAtoms.loadReadableIds(appAtomRegistry, environmentId);
