/**
 * Fork: how a sidebar tab shows the status of its most urgent thread. The icon is the
 * `status.<kind>` theme icon slot (`AppIcon`), which the thread row badge uses too. The label and
 * colour mirror the row (`topStatus` in `SidebarThreadRow`, Sidebar.tsx); update them when
 * upstream changes a row status.
 */
import type { AppIconSlot } from "../AppIcon";

/** The row statuses that a tab can show, one `status.<kind>` icon slot each. */
type SidebarV2TopStatusKind =
  | "approval"
  | "done"
  | "failed"
  | "limited"
  | "input"
  | "request"
  | "waiting"
  | "woke"
  | "working";

export interface SidebarTabStatus {
  readonly kind: SidebarV2TopStatusKind;
  readonly label: string;
  readonly className: string;
  /** Every status has an icon on a tab. */
  readonly slot: AppIconSlot;
}

const TAB_STATUS: Record<SidebarV2TopStatusKind, Omit<SidebarTabStatus, "kind" | "slot">> = {
  working: { label: "Working", className: "text-info-foreground" },
  waiting: { label: "Waiting", className: "text-muted-foreground" },
  approval: { label: "Approval", className: "text-warning-foreground" },
  input: { label: "Input", className: "text-indigo-600 dark:text-indigo-300" },
  request: { label: "Request", className: "text-guest-foreground" },
  limited: { label: "Limited", className: "text-warning-foreground" },
  failed: { label: "Failed", className: "text-error-foreground" },
  woke: { label: "Woke", className: "text-warning-foreground" },
  done: { label: "Done", className: "text-success-foreground" },
};

export const sidebarTabStatus = (kind: SidebarV2TopStatusKind): SidebarTabStatus => ({
  kind,
  ...TAB_STATUS[kind],
  slot: `status.${kind}`,
});
