import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const state: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  archiveBlock: null,
  canMarkUnread: true,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
    markUnread: true,
  },
  snoozePresets: [],
};

const archiveOf = (overrides: Partial<ThreadActionMenuState>) =>
  buildThreadActionMenuItems({ ...state, ...overrides }).find((item) => item.id === "archive");

describe("buildThreadActionMenuItems (fork)", () => {
  it("names the reason of a disabled Archive, because a native menu has no tooltip", () => {
    expect(archiveOf({})).toMatchObject({ disabled: false });
    const program = archiveOf({ archiveBlock: "program" });
    const agent = archiveOf({ archiveBlock: "agent" });
    expect(program?.disabled).toBe(true);
    expect(agent?.disabled).toBe(true);
    expect(program?.label).toContain("program");
    expect(agent?.label).toContain("agent");
  });

  it("leaves out Mark unread where the thread has none", () => {
    const ids = buildThreadActionMenuItems({
      ...state,
      supports: { ...state.supports, markUnread: false },
    }).map((item) => item.id);
    expect(ids).not.toContain("mark-unread");
  });
});
