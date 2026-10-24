import {
  EnvironmentId,
  RuntimeRequestId,
  TERMINAL_THREAD_INSTANCE_ID,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import type { TerminalThreadStates } from "./forkTerminalThreads.ts";
import { v2Now, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { createEnvironmentThreadShellAtoms } from "./threadShell.ts";

const environmentId = EnvironmentId.make("environment-v2");
const remoteEnvironmentId = EnvironmentId.make("remote-environment-v2");

function makeHarness(environmentIds: ReadonlyArray<EnvironmentId> = [environmentId]) {
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<OrchestrationV2ShellSnapshot | null>(v2ShellSnapshot),
  );
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map(
      environmentIds.map((id) => [
        id,
        {
          target: new PrimaryConnectionTarget({
            environmentId: id,
            label: "Environment",
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ]),
    ),
  });
  return {
    registry: AtomRegistry.make(),
    snapshotAtom,
    catalogValueAtom,
    threads: createEnvironmentThreadShellAtoms({ catalogValueAtom, snapshotAtom }),
  };
}
describe("v2 thread shell lists", () => {
  it("lists a task a linked environment runs for a listed thread under that thread", () => {
    const { registry, threads, snapshotAtom, catalogValueAtom } = makeHarness([
      environmentId,
      remoteEnvironmentId,
    ]);
    const parent = v2ThreadShell;
    const task = {
      ...v2ThreadShell,
      id: ThreadId.make("remote-task"),
      creationSource: "mcp" as const,
      status: "running" as const,
      activityRunStatus: "running" as const,
      delegatedFrom: { environmentId, threadId: parent.id, title: parent.title },
    };
    const helper = {
      ...task,
      id: ThreadId.make("remote-helper"),
      delegatedFrom: undefined,
      lineage: {
        ...task.lineage,
        parentThreadId: task.id,
        relationshipToParent: "subagent" as const,
      },
    };
    const approval = {
      id: RuntimeRequestId.make("cat-file"),
      kind: "command" as const,
      createdAt: v2Now,
    };
    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [parent] });
    registry.set(snapshotAtom(remoteEnvironmentId), {
      ...v2ShellSnapshot,
      threads: [task, helper],
    });
    const parentRef = { environmentId, threadId: parent.id };
    const inputs = threads.childThreadInputsAtom(parentRef);
    const disposeNavigation = registry.mount(threads.navigationThreadShellsAtom);
    const disposeParent = registry.mount(threads.threadShellAtom(parentRef));
    const disposeInputs = registry.mount(inputs);
    const listed = () =>
      registry
        .get(threads.navigationThreadShellsAtom)
        .map((thread) => `${thread.environmentId}/${thread.id}`);
    expect(listed()).toEqual([`${environmentId}/${parent.id}`]);

    // The helper the task started there asks for approval: the parent here hears of it.
    registry.set(snapshotAtom(remoteEnvironmentId), {
      ...v2ShellSnapshot,
      threads: [task, { ...helper, pendingRuntimeRequest: approval }],
    });
    expect(registry.get(threads.threadShellAtom(parentRef))?.pendingSubagentRequest).toBe(
      "approval",
    );
    expect(registry.get(inputs).map((thread) => `${thread.environmentId}/${thread.id}`)).toEqual([
      `${remoteEnvironmentId}/${helper.id}`,
    ]);

    // A task whose parent is gone there is listed on its own, as is one whose
    // parent's environment is switched off.
    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [] });
    expect(listed()).toEqual([`${remoteEnvironmentId}/${task.id}`]);
    // Archiving the parent here leaves the task there unarchived, so it is listed on its own.
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [{ ...parent, archivedAt: v2Now }],
    });
    expect(listed()).toEqual([`${remoteEnvironmentId}/${task.id}`]);
    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [parent] });
    expect(listed()).toEqual([`${environmentId}/${parent.id}`]);
    const catalog = registry.get(catalogValueAtom);
    const entries = new Map(catalog.entries);
    entries.set(environmentId, { ...entries.get(environmentId)!, enabled: false });
    registry.set(catalogValueAtom, { ...catalog, entries });
    expect(listed()).toEqual([`${remoteEnvironmentId}/${task.id}`]);
    disposeInputs();
    disposeParent();
    disposeNavigation();
    registry.dispose();
  });
});

describe("terminal thread state on thread shells", () => {
  it("puts the main terminal state on terminal threads, and reads it only for them", () => {
    const { registry, snapshotAtom, catalogValueAtom } = makeHarness();
    const reads: Array<EnvironmentId> = [];
    const states = Atom.make<TerminalThreadStates>(new Map());
    const threads = createEnvironmentThreadShellAtoms({
      catalogValueAtom,
      snapshotAtom,
      terminalThreadStatesAtom: (id) => {
        reads.push(id);
        return states;
      },
    });
    const agent = v2ThreadShell;
    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [agent] });
    expect(registry.get(threads.threadShellsAtom)[0]?.terminal).toBeUndefined();
    // An environment without terminal threads never subscribes to terminal metadata.
    expect(reads).toEqual([]);

    const shell = {
      ...v2ThreadShell,
      id: ThreadId.make("shell"),
      providerInstanceId: TERMINAL_THREAD_INSTANCE_ID,
    };
    const running = { status: "running", attention: null, running: true, failedAt: null } as const;
    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, threads: [agent, shell] });
    registry.set(states, new Map([[shell.id, running]]));
    const listed = registry.get(threads.threadShellsAtom);
    expect(listed.map((thread) => thread.terminal)).toEqual([undefined, running]);
    expect(registry.get(threads.threadShellAtom({ environmentId, threadId: shell.id }))).toBe(
      listed[1],
    );

    // A new set with the same state object keeps the list, so no row re-renders.
    registry.set(states, new Map([[shell.id, running]]));
    expect(registry.get(threads.threadShellsAtom)).toBe(listed);
  });
});
