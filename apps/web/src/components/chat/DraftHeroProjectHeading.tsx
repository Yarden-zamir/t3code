import { useGT } from "gt-react";
import { XIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { observeResize } from "~/lib/observeResize";
import { ShortcutHint, ShortcutTrigger } from "../focusLevels/ShortcutHint";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup } from "../ui/tooltip";

const PROJECT_SLOT = "\uE000";

export function DraftHeroProjectHeading({
  children,
  projectName,
  onStartWithoutProject,
}: {
  children: ReactNode;
  projectName: string;
  onStartWithoutProject: (() => void) | null;
}) {
  const gt = useGT();
  // One sentence for translators; the layout places the project picker at the placeholder.
  // The flex gap stands in for the space before it; the suffix keeps its own leading space.
  const [before = "", after = ""] = gt("What should we build in {project}?", {
    project: PROJECT_SLOT,
  }).split(PROJECT_SLOT);
  const buildIn = before.trim();
  const buildInSuffix = after.trimEnd();
  const containerRef = useRef<HTMLDivElement>(null);
  const inlineRef = useRef<HTMLSpanElement>(null);
  const [fitsInline, setFitsInline] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the heading against its container via ResizeObserver to choose inline or stacked layout
  useLayoutEffect(() => {
    const container = containerRef.current;
    const inline = inlineRef.current;
    if (!container || !inline) return;

    // Measure the full inline heading independently of its current layout, so
    // moving the name below it cannot make the fit check oscillate.
    const update = () =>
      setFitsInline(
        inline.getBoundingClientRect().width <= container.getBoundingClientRect().width,
      );
    update();
    return observeResize([container, inline], update);
  }, []);

  return (
    <div ref={containerRef} className="group/draft-hero relative w-full" data-inline={fitsInline}>
      <span
        aria-hidden="true"
        className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden"
      >
        <span
          ref={inlineRef}
          className="flex w-max items-baseline gap-2 whitespace-nowrap font-normal text-3xl tracking-tight"
        >
          <span>{buildIn}</span>
          <span>
            <span className="font-medium">{projectName}</span>
            {onStartWithoutProject ? (
              // Counts the clear button, so the inline heading keeps room for it after the "?".
              <Button size="icon-micro" variant="ghost-muted" />
            ) : null}
            {buildInSuffix}
          </span>
        </span>
      </span>
      <h1 className="flex w-full flex-col items-center justify-center gap-2 text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl lg:group-data-[inline=true]/draft-hero:flex-row">
        <span className="max-w-full lg:group-data-[inline=true]/draft-hero:shrink-0 [@media(max-height:28rem)]:sr-only">
          <span className="lg:group-data-[inline=true]/draft-hero:hidden">
            {gt("What should we build?")}
          </span>
          <span className="hidden lg:group-data-[inline=true]/draft-hero:inline">{buildIn}</span>
        </span>
        <span className="relative flex min-w-0 max-w-full items-baseline justify-center text-base tracking-normal lg:group-data-[inline=true]/draft-hero:text-3xl lg:group-data-[inline=true]/draft-hero:tracking-tight">
          <span className="min-w-0">{children}</span>
          {onStartWithoutProject ? (
            // Inline, it hangs after the "?", so the resting heading shows no gap before it.
            <span className="pointer-events-auto shrink-0 self-center opacity-0 transition-opacity group-focus-within/draft-hero:opacity-100 group-hover/draft-hero:opacity-100 pointer-coarse:opacity-100 motion-reduce:opacity-100 motion-reduce:transition-none lg:group-data-[inline=true]/draft-hero:absolute lg:group-data-[inline=true]/draft-hero:top-1/2 lg:group-data-[inline=true]/draft-hero:left-full lg:group-data-[inline=true]/draft-hero:-translate-y-1/2">
              <Tooltip>
                <ShortcutTrigger
                  command="chat.newWithoutProject"
                  render={
                    <Button
                      size="icon-micro"
                      variant="ghost-muted"
                      aria-label={gt("Start without a project")}
                      onClick={onStartWithoutProject}
                    />
                  }
                >
                  <XIcon />
                </ShortcutTrigger>
                <TooltipPopup side="top">
                  {gt("Start without a project")}
                  <ShortcutHint command="chat.newWithoutProject" />
                </TooltipPopup>
              </Tooltip>
            </span>
          ) : null}
          <span className="hidden shrink-0 whitespace-pre lg:group-data-[inline=true]/draft-hero:inline [@media(max-height:28rem)]:hidden!">
            {buildInSuffix}
          </span>
        </span>
      </h1>
    </div>
  );
}
