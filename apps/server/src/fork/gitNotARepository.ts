/** Git 2.56 reports a `.git` file that points to a missing folder with a new message. */
const NOT_A_REPOSITORY_MESSAGES = [
  "not a git repository",
  "gitfile does not point to a valid repository",
] as const;

export function isNotGitRepositoryMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return NOT_A_REPOSITORY_MESSAGES.some((message) => lower.includes(message));
}
