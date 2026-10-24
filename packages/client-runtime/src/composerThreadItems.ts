import type {
  EnvironmentId,
  MachineMapReadableEnvironment,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

const COMPOSER_THREAD_RESULT_LIMIT = 5;

export interface ComposerThreadCandidate {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface ComposerThreadItem {
  readonly id: string;
  readonly type: "thread";
  readonly thread: ScopedThreadRef;
  readonly label: string;
  readonly description: string;
}

/** An environment whose threads the composer's agent can read, with its machine name if known. */
export interface ReadableThreadEnvironment {
  readonly environmentId: EnvironmentId;
  readonly name: string | null;
}

/**
 * Fork: MM-1906, MM-1907. The composer's environment first, then the machines that its server
 * reads through the machine map (`machineMap.readableEnvironments`). Without that answer, for
 * example from a server without the machine map, the agent reads only its own environment.
 */
export function readableThreadEnvironments(
  environmentId: EnvironmentId,
  served: ReadonlyArray<MachineMapReadableEnvironment> | null,
): ReadonlyArray<ReadableThreadEnvironment> {
  const self = served?.find((entry) => entry.environmentId === environmentId);
  return [
    { environmentId, name: self?.name ?? null },
    ...(served ?? []).filter((entry) => entry.environmentId !== environmentId),
  ];
}

/**
 * The agent reads threads on its own server and, through the machine map, on the machines in
 * `readable`. With more than one machine, each item names its machine.
 */
export function matchComposerThreadItems(input: {
  shells: ReadonlyArray<ComposerThreadCandidate>;
  readable: ReadonlyArray<ReadableThreadEnvironment>;
  excludeThreadId: ThreadId | null;
  query: string;
}): ComposerThreadItem[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  const names = new Map(input.readable.map((entry) => [entry.environmentId, entry.name]));
  const namesMachines = input.readable.length > 1;
  return input.shells
    .filter(
      (shell) =>
        names.has(shell.environmentId) &&
        shell.id !== input.excludeThreadId &&
        shell.archivedAt === null &&
        shell.title.toLowerCase().includes(query),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, COMPOSER_THREAD_RESULT_LIMIT)
    .map((shell) => {
      const machine = namesMachines ? names.get(shell.environmentId) : null;
      return {
        id: `thread:${shell.environmentId}:${shell.id}`,
        type: "thread",
        thread: { environmentId: shell.environmentId, threadId: shell.id },
        label: shell.title,
        description: machine ? `Thread · ${machine}` : "Thread",
      };
    });
}
