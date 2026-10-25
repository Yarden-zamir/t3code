import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type MessagePin,
  type PinnedMessages,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  messagePinExcerpt,
  messagePinKey,
  messagePinsNewestFirst,
  messagePinState,
  pinMessagePatch,
  unpinMessagePatch,
  type MessagePinsPatch,
} from "@t3tools/shared/messagePins";
import { Link } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { PinIcon, PinOffIcon } from "lucide-react";
import { useState, type ReactElement } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThreadShell, useQuietThreadShell } from "../../state/entities";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { forkMessageLinkNavigation } from "./ForkMessageLinkTarget";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

/*
 * Fork: message pins. The `pinnedMessages` server setting holds them, so every client of an
 * environment shows the same pins. The client setting `messagePins` shows the buttons and lists.
 */

const NO_PINS: PinnedMessages = {};

const pinnedMessagesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) => get(serverEnvironment.settingsValueAtom(environmentId))?.pinnedMessages ?? NO_PINS,
  ),
);

/** One boolean per message, so a pin elsewhere does not render every message again. */
const messagePinnedAtom = Atom.family((key: string) => {
  const [environmentId, threadId, messageId] = key.split("\u0000") as [
    EnvironmentId,
    ThreadId,
    string,
  ];
  return Atom.make(
    (get) =>
      get(pinnedMessagesAtom(environmentId))[messagePinKey(threadId, messageId)] !== undefined,
  );
});

export interface EnvironmentMessagePin {
  readonly environmentId: EnvironmentId;
  readonly pin: MessagePin;
}

/** The pins of every connected environment, newest first. */
const allMessagePinsAtom = Atom.make((get): ReadonlyArray<EnvironmentMessagePin> => {
  const pins: EnvironmentMessagePin[] = [];
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    for (const pin of messagePinsNewestFirst(config.settings.pinnedMessages)) {
      pins.push({ environmentId, pin });
    }
  }
  return pins.toSorted((left, right) => right.pin.pinnedAt.localeCompare(left.pin.pinnedAt));
});

export function useForkMessagePinsEnabled(): boolean {
  return useClientSettings((settings) => settings.messagePins);
}

function useWritePins() {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "message pin update");
  return (environmentId: EnvironmentId, patch: MessagePinsPatch) =>
    void updateSettings({ environmentId, input: { patch: { pinnedMessages: patch } } });
}

/**
 * Fork: pins or unpins a message of `threadRef`. False when the setting is off or there is no
 * message, so a keyboard command can fall through.
 */
export function useForkToggleMessagePin(threadRef: ScopedThreadRef | null) {
  const enabled = useForkMessagePinsEnabled();
  const writePins = useWritePins();
  return (message: { readonly id: string; readonly text?: string } | undefined) => {
    if (!enabled || !threadRef || !message) return false;
    const { environmentId, threadId } = threadRef;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      toastManager.add({
        type: "error",
        title: "Could not pin the message",
        description: "This client cannot change the settings of this environment.",
      });
      return true;
    }
    const pins = appAtomRegistry.get(pinnedMessagesAtom(environmentId));
    const pin: MessagePin = {
      threadId,
      messageId: message.id as MessagePin["messageId"],
      pinnedAt: new Date().toISOString(),
      excerpt: messagePinExcerpt(message.text ?? ""),
      threadTitle: readThreadShell(threadRef)?.title ?? "",
    };
    const result = pinMessagePatch(pins, pin);
    if (result._tag === "AlreadyPinned") writePins(environmentId, unpinMessagePatch(pin));
    else if (result._tag === "Patch") writePins(environmentId, result.patch);
    else {
      toastManager.add({
        type: "error",
        title: "Could not pin the message",
        description: "This environment has the most pins it keeps. Unpin a message first.",
      });
    }
    return true;
  };
}

/** Fork: the pin toggle of a message, next to Copy message link. */
export function ForkPinMessageButton(props: {
  readonly threadRef: ScopedThreadRef;
  readonly messageId: string;
  readonly text: string | undefined;
}) {
  const toggle = useForkToggleMessagePin(props.threadRef);
  const pinned = useAtomValue(
    messagePinnedAtom(
      `${props.threadRef.environmentId}\u0000${props.threadRef.threadId}\u0000${props.messageId}`,
    ),
  );
  const label = pinned ? "Unpin message" : "Pin message";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-pressed={pinned}
            // The message meta row stays visible while it holds a pinned message.
            data-fork-pinned={pinned ? "" : undefined}
            size="xs"
            variant="ghost-muted"
            onClick={() =>
              toggle({ id: props.messageId, ...(props.text ? { text: props.text } : {}) })
            }
            type="button"
          />
        }
      >
        <PinIcon className={cn("size-3", pinned && "fill-current text-primary")} />
      </TooltipTrigger>
      <TooltipPopup>
        <p>{label}</p>
      </TooltipPopup>
    </Tooltip>
  );
}

const NO_THREAD_ATOM = Atom.make(null);
const NO_HISTORY_ATOM = Atom.make(null);

function MessagePinRow(
  props: EnvironmentMessagePin & {
    /** Check the message too. Only for a loaded thread: a read of another thread loads it. */
    readonly checkMessage: boolean;
    readonly onOpen: () => void;
  },
) {
  const { environmentId, pin } = props;
  const writePins = useWritePins();
  const ref = scopeThreadRef(environmentId, pin.threadId);
  const shell = useQuietThreadShell(ref);
  const history = useAtomValue(
    props.checkMessage ? environmentThreadDetails.historyAtom(ref) : NO_HISTORY_ATOM,
  );
  const thread = useAtomValue(
    props.checkMessage ? environmentThreadDetails.quietThreadAtom(ref) : NO_THREAD_ATOM,
  );
  const state = messagePinState(pin, {
    threadKnown: shell !== null,
    loadedMessageIds:
      thread !== null && history !== null && !history.hasMoreHistory && !history.loading
        ? new Set(thread.projection.messages.map((message) => message.id))
        : null,
  });
  const title = shell?.title.trim() || pin.threadTitle || pin.threadId;
  const canWrite = readEnvironmentScope(environmentId, AuthSettingsWriteScope);
  return (
    <li className="flex items-start gap-1 rounded-md hover:bg-accent/60">
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId, threadId: pin.threadId }}
        {...forkMessageLinkNavigation(pin.messageId)}
        onClick={props.onOpen}
        className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left no-underline outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="line-clamp-2 text-sm text-foreground">{pin.excerpt || "Message"}</span>
        <span className="flex min-w-0 gap-1 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">{title}</span>
          <span className="shrink-0">· {formatRelativeTimeLabel(pin.pinnedAt)}</span>
        </span>
        {state !== "available" ? (
          <span className="block text-xs text-destructive">
            {state === "thread-missing" ? "Thread archived or deleted" : "Message deleted"}
          </span>
        ) : null}
      </Link>
      <Button
        aria-label="Unpin message"
        size="icon-xs"
        variant="ghost-muted"
        className="me-1 mt-1.5"
        disabled={!canWrite}
        onClick={() => writePins(environmentId, unpinMessagePatch(pin))}
        type="button"
      >
        <PinOffIcon className="size-3.5" />
      </Button>
    </li>
  );
}

function MessagePinsPopover(props: {
  readonly trigger: ReactElement;
  readonly pins: ReadonlyArray<EnvironmentMessagePin>;
  readonly checkMessagesOf: ThreadId | null;
  readonly side: "top" | "left";
  readonly tooltip?: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = <PopoverTrigger render={props.trigger} />;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {props.tooltip ? (
        <Tooltip>
          <TooltipTrigger render={trigger} />
          <TooltipPopup side={props.side}>{props.tooltip}</TooltipPopup>
        </Tooltip>
      ) : (
        trigger
      )}
      <PopoverPopup side={props.side} align="start" width="md" padding="compact">
        <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">Pinned messages</p>
        {props.pins.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            No pinned messages. Pin one with the pin button of a message.
          </p>
        ) : open ? (
          // Mounted only while open: each row reads its thread.
          <ul className="m-0 flex max-h-96 list-none flex-col gap-0.5 overflow-y-auto p-0">
            {props.pins.map((entry) => (
              <MessagePinRow
                key={`${entry.environmentId}\u0000${messagePinKey(entry.pin.threadId, entry.pin.messageId)}`}
                {...entry}
                checkMessage={entry.pin.threadId === props.checkMessagesOf}
                onOpen={() => setOpen(false)}
              />
            ))}
          </ul>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

/** Fork: "Pins" in thread details. It lists the pins of this thread. */
export function ForkThreadPinsButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const enabled = useForkMessagePinsEnabled();
  const pins = useAtomValue(pinnedMessagesAtom(props.environmentId));
  if (!enabled) return null;
  const threadPins = messagePinsNewestFirst(pins)
    .filter((pin) => pin.threadId === props.threadId)
    .map((pin) => ({ environmentId: props.environmentId, pin }));
  return (
    <MessagePinsPopover
      side="left"
      pins={threadPins}
      checkMessagesOf={props.threadId}
      trigger={
        <ThreadDetailsControl size="sm" variant="ghost" aria-label="Pinned messages">
          <PinIcon aria-hidden="true" className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
            Pins
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">{threadPins.length}</span>
        </ThreadDetailsControl>
      }
    />
  );
}

/** Fork: "Pins" in the sidebar footer, next to Usage, while at least one pin exists. */
export function ForkSidebarPinsItem() {
  const enabled = useForkMessagePinsEnabled();
  const pins = useAtomValue(allMessagePinsAtom);
  if (!enabled || pins.length === 0) return null;
  return (
    <SidebarMenuItem className="shrink-0">
      <MessagePinsPopover
        side="top"
        tooltip="Pinned messages"
        pins={pins}
        checkMessagesOf={null}
        trigger={
          <SidebarMenuButton aria-label="Pinned messages" size="icon">
            <PinIcon />
          </SidebarMenuButton>
        }
      />
    </SidebarMenuItem>
  );
}
