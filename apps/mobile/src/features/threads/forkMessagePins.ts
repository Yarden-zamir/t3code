import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthSettingsWriteScope,
  MessageId,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  messagePinExcerpt,
  messagePinKey,
  pinMessagePatch,
  unpinMessagePatch,
} from "@t3tools/shared/messagePins";

import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Fork: Pin or Unpin for the long-press menu of a message, while the server setting
 * `mobileMessagePins` is on, else null. The desktop and web app list the pins.
 */
export function useForkMessagePin(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: string | null;
  readonly text: string;
}) {
  const settings = useEnvironmentServerConfig(input.environmentId)?.settings;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "message pin update");
  if (settings?.mobileMessagePins !== true || input.messageId === null) return null;
  const { environmentId, threadId } = input;
  const messageId = MessageId.make(input.messageId);
  const pins = settings.pinnedMessages;
  const pinned = pins[messagePinKey(threadId, messageId)] !== undefined;
  const toggle = () => {
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      Dialog.alert(
        "Could not pin the message",
        "This app cannot change the settings of this server.",
      );
      return;
    }
    const shell = appAtomRegistry.get(
      environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId)),
    );
    const pin = {
      threadId,
      messageId,
      pinnedAt: new Date().toISOString(),
      excerpt: messagePinExcerpt(input.text),
      threadTitle: shell?.title ?? "",
    };
    const result = pinned ? null : pinMessagePatch(pins, pin);
    if (result?._tag === "Full") {
      Dialog.alert("Could not pin the message", "This server has the most pins it keeps.");
      return;
    }
    const patch = result?._tag === "Patch" ? result.patch : unpinMessagePatch(pin);
    void updateSettings({ environmentId, input: { patch: { pinnedMessages: patch } } });
  };
  return { pinned, toggle };
}
