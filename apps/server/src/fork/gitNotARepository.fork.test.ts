import { expect, it } from "@effect/vitest";

import { isNotGitRepositoryMessage } from "./gitNotARepository.ts";

it("knows the messages of Git 2.55 and Git 2.56 for a folder outside a repository", () => {
  expect(isNotGitRepositoryMessage("fatal: not a git repository: (null)")).toBe(true);
  expect(
    isNotGitRepositoryMessage("fatal: gitfile does not point to a valid repository: /w/.git"),
  ).toBe(true);
  expect(isNotGitRepositoryMessage("fatal: Unable to create '/w/.git/index.lock'")).toBe(false);
});
