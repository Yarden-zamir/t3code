import type { EnvironmentId } from "@t3tools/contracts";

interface ProjectRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
}

interface StartProject {
  readonly environmentId: EnvironmentId;
  readonly id: string;
}

/**
 * Fork: what New thread opens for `mobileNewThreadProject` `last` or `none`. `wait` keeps the
 * picker and decides again when the projects or connections change. `picker` keeps it for good.
 */
export type NewThreadStartChoice<Project> =
  | { readonly kind: "project"; readonly project: Project }
  | { readonly kind: "start-scratch" }
  | { readonly kind: "wait" }
  | { readonly kind: "picker" };

/**
 * A project on a connected environment wins over one on an offline environment, so a saved
 * connection that is offline does not take the new thread while another one is connected. The
 * last choice of the user stays when its environment is connected. With no connected environment
 * at all, as at a cold start, the remembered project opens at once, before a server connects.
 */
export function newThreadStartChoice<Project extends StartProject>(input: {
  /** `none`, or `last` when the last new thread had no project. */
  readonly scratch: boolean;
  readonly last: ProjectRef | null | undefined;
  /** The project of the last thread without a project. */
  readonly rememberedScratch: ProjectRef | undefined;
  readonly projects: ReadonlyArray<Project>;
  readonly isScratch: (project: Project) => boolean;
  readonly connected: ReadonlySet<EnvironmentId>;
  /** A connected environment can make the project of a thread without a project. */
  readonly canStartScratch: boolean;
}): NewThreadStartChoice<Project> {
  const { projects, connected } = input;
  const online = (project: Project) => connected.has(project.environmentId);
  const find = (ref: ProjectRef | null | undefined) =>
    ref
      ? projects.find(
          (candidate) =>
            candidate.environmentId === ref.environmentId && candidate.id === ref.projectId,
        )
      : undefined;

  if (input.scratch) {
    const known = find(input.rememberedScratch) ?? projects.find(input.isScratch);
    if (connected.size === 0) return known ? { kind: "project", project: known } : { kind: "wait" };
    if (known && online(known)) return { kind: "project", project: known };
    const knownOnline = projects.find((project) => online(project) && input.isScratch(project));
    if (knownOnline) return { kind: "project", project: knownOnline };
    return input.canStartScratch ? { kind: "start-scratch" } : { kind: "wait" };
  }

  // The project can arrive with the environment snapshot. Until then, the picker shows.
  const project = find(input.last);
  if (!project) return { kind: "wait" };
  if (connected.size === 0 || online(project)) return { kind: "project", project };
  // The last project is offline and another environment is connected: the user picks.
  return { kind: "picker" };
}
