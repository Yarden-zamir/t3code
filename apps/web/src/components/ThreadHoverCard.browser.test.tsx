import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { ThreadHoverCard, ThreadHoverCardPopup, ThreadHoverCardRow } from "./ThreadHoverCard";
import { ThreadPullRequestsMiniList } from "./ThreadStatusIndicators";
import { PreviewCard, PreviewCardTrigger } from "./ui/preview-card";

const pullRequest: ThreadPullRequestLink = {
  host: "github.com",
  repository: "example/repo",
  number: 7,
  url: "https://github.com/example/repo/pull/7",
  source: "manual",
  linkedAt: "2026-01-01T00:00:00Z",
  stack: null,
  snapshot: {
    state: "open",
    title: "Hover card rows stay clickable",
    headBranch: "feature",
    baseBranch: "main",
    isDraft: false,
    updatedAt: null,
    syncedAt: "2026-01-03T00:00:00Z",
  },
};

it("keeps the card open while the pointer moves into it and opens a row on click", async () => {
  const onOpenPullRequest = vi.fn((event: { preventDefault: () => void }) =>
    event.preventDefault(),
  );
  await using screen = await render(
    <PreviewCard>
      <PreviewCardTrigger render={<button type="button" />}>Thread row</PreviewCardTrigger>
      <ThreadHoverCardPopup>
        <ThreadHoverCard title="Thread title">
          <ThreadHoverCardRow action={null}>cli-utils</ThreadHoverCardRow>
        </ThreadHoverCard>
        <ThreadPullRequestsMiniList
          pullRequests={[pullRequest]}
          onOpenPullRequest={onOpenPullRequest}
        />
      </ThreadHoverCardPopup>
    </PreviewCard>,
  );

  await userEvent.hover(screen.getByRole("button", { name: "Thread row" }));
  const row = screen.getByRole("link", { name: /#7/ });
  await expect.element(row).toBeVisible();

  await userEvent.hover(row);
  await userEvent.click(row);
  expect(onOpenPullRequest).toHaveBeenCalledWith(
    expect.anything(),
    "https://github.com/example/repo/pull/7",
  );
  await expect.element(row).toBeVisible();
});
