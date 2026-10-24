import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

/** Fork: how many recent threads the assistant panel picker lists before a search. */
export const RECENT_THREAD_LIMIT = 8;
/** A search lists more matches, but stays bounded so the picker renders fast. */
const SEARCH_RESULT_LIMIT = 30;

type ThreadForTarget = Pick<
  EnvironmentThreadShell,
  "title" | "archivedAt" | "updatedAt" | "lastVisitedAt" | "environmentId" | "projectId"
>;

const lastSeen = (thread: ThreadForTarget) => thread.lastVisitedAt ?? thread.updatedAt;

function matches(text: string, query: string): boolean {
  return text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

/** The thread that the user opened last, for "The panel starts with: The last thread". */
export function lastOpenedThread<Thread extends ThreadForTarget>(
  threads: ReadonlyArray<Thread>,
): Thread | null {
  let last: Thread | null = null;
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    if (last === null || lastSeen(thread) > lastSeen(last)) last = thread;
  }
  return last;
}

/** Unarchived threads, last opened first, filtered by title. */
export function recentThreadsForPicker<Thread extends ThreadForTarget>(
  threads: ReadonlyArray<Thread>,
  query: string,
): ReadonlyArray<Thread> {
  const searching = query.trim().length > 0;
  return threads
    .filter((thread) => thread.archivedAt === null && (!searching || matches(thread.title, query)))
    .sort((left, right) => lastSeen(right).localeCompare(lastSeen(left)))
    .slice(0, searching ? SEARCH_RESULT_LIMIT : RECENT_THREAD_LIMIT);
}

/** Projects with the most recent thread activity first, filtered by title. */
export function projectsForPicker<
  Project extends Pick<EnvironmentProject, "id" | "environmentId" | "title">,
>(
  projects: ReadonlyArray<Project>,
  threads: ReadonlyArray<ThreadForTarget>,
  query: string,
): ReadonlyArray<Project> {
  const latestByProject = new Map<string, string>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const key = `${thread.environmentId}:${thread.projectId}`;
    const seen = lastSeen(thread);
    if ((latestByProject.get(key) ?? "") < seen) latestByProject.set(key, seen);
  }
  const latest = (project: Project) =>
    latestByProject.get(`${project.environmentId}:${project.id}`) ?? "";
  return projects
    .filter((project) => matches(project.title, query))
    .sort(
      (left, right) =>
        latest(right).localeCompare(latest(left)) || left.title.localeCompare(right.title),
    );
}
