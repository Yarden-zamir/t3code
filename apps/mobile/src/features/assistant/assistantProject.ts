import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";

import type { AssistantProjectRef } from "../../persistence/forkVoicePreferences";
import type { Preferences } from "../../persistence/mobile-preferences";

/**
 * Fork: the project of a thread started from the Android assistant: the chosen project, then the
 * project of the last new thread, then the project for threads without a project, then the first.
 */
export function resolveAssistantProject(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  /** The project chosen in Settings > Voice; it wins while it exists. */
  readonly chosen: AssistantProjectRef | null;
  readonly preferences: Pick<Preferences, "lastNewThreadProject" | "scratchProject">;
  readonly scratchWorkspaceRoot: (environmentId: EnvironmentId) => string | null | undefined;
}): EnvironmentProject | null {
  const { projects, preferences } = input;
  const find = (ref: { readonly environmentId: EnvironmentId; readonly projectId: string }) =>
    projects.find(
      (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
    );
  const last = preferences.lastNewThreadProject;
  const scratch = preferences.scratchProject;
  return (
    (input.chosen ? find(input.chosen) : undefined) ??
    (last ? find(last) : undefined) ??
    (scratch ? find(scratch) : undefined) ??
    projects.find((project) =>
      isScratchProject(project, input.scratchWorkspaceRoot(project.environmentId)),
    ) ??
    projects[0] ??
    null
  );
}
