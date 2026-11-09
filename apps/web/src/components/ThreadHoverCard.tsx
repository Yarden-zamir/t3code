import type { ComponentProps, ReactNode } from "react";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";
import { PreviewCardPopup } from "./ui/preview-card";
import { cn } from "~/lib/utils";

// A hover card, not a tooltip: the pointer can move into it and use its rows.
export function ThreadHoverCardPopup({
  className,
  ...props
}: ComponentProps<typeof PreviewCardPopup>) {
  return (
    <PreviewCardPopup
      {...props}
      variant="glass"
      className={cn("max-w-80 text-left whitespace-normal", className)}
    />
  );
}

export function ThreadHoverCard({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 max-w-80 flex-col gap-2 px-3 py-3">
      <div className="min-w-0 truncate text-xs leading-tight font-medium text-foreground">
        {title}
      </div>
      <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">{children}</div>
      {footer}
    </div>
  );
}

/**
 * What a click on a card row does. A row must say so: `null` for a data row that only informs,
 * so no row can be a button in one card and dead text in another by accident.
 */
export type ThreadHoverCardRowAction =
  | { readonly label: string; readonly onSelect: () => void }
  | {
      readonly copy: string;
      /** The row's accessible name, such as "Copy branch name". */
      readonly label: string;
      /** The success toast title, such as "Branch copied". */
      readonly copiedTitle: string;
    }
  | null;

function copyRowValue(action: Extract<ThreadHoverCardRowAction, { copy: string }>) {
  const subject = action.label.replace(/^Copy /u, "").toLowerCase();
  writeTextToClipboard(action.copy, subject).then(
    () =>
      toastManager.add({ type: "success", title: action.copiedTitle, description: action.copy }),
    (error: unknown) =>
      toastManager.add({
        type: "error",
        title: `Failed to copy ${subject}`,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
  );
}

/** A row of a card: an icon and a value, as a button when `action` is set and as text otherwise. */
export function ThreadHoverCardRow({
  action,
  tone,
  layout = "start",
  children,
}: {
  action: ThreadHoverCardRowAction;
  /** A status row's color. */
  tone?: "warning" | "error";
  /** `spread` pushes the last child right; `top` aligns a multi-line value to its icon. */
  layout?: "start" | "spread" | "top";
  children: ReactNode;
}) {
  const toneClass = tone === "warning" ? "text-warning" : tone === "error" ? "text-error" : null;
  const layoutClass =
    layout === "spread" ? "justify-between" : layout === "top" ? "items-start" : null;
  if (action === null) {
    return (
      <div className={cn("flex min-w-0 items-center gap-2", layoutClass, toneClass)}>
        {children}
      </div>
    );
  }
  const label = action.label;
  return (
    <Button
      size="xs"
      variant="ghost"
      className={cn("-mx-2 justify-start", layoutClass)}
      aria-label={label}
      title={label}
      onClick={() => ("copy" in action ? copyRowValue(action) : action.onSelect())}
    >
      {children}
    </Button>
  );
}

/** The actions of a card, as buttons in a row under its content. */
export function ThreadHoverCardActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-1 border-t border-border/60 pt-2">{children}</div>;
}

export function ThreadHoverCardAction(props: ComponentProps<typeof Button>) {
  return <Button size="xs" variant="outline" {...props} />;
}
