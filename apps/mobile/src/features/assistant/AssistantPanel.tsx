import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  MessageId,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { BackHandler, Pressable, View } from "react-native";
import {
  KeyboardAvoidingView,
  KeyboardProvider,
  useKeyboardState,
} from "react-native-keyboard-controller";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { IconButton } from "../../components/ui/IconButton";
import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import {
  convertPastedImagesToAttachments,
  createPastedTextComposerAttachment,
  type DraftComposerAttachment,
} from "../../lib/composerImages";
import {
  assistantNative,
  type AnnotationStroke,
  type AssistantCapture,
  type RecentPhoto,
} from "../../native/assistant";
import { appAtomRegistry } from "../../state/atom-registry";
import { useNavigationThreadShells, useProjects, useServerConfigs } from "../../state/entities";
import { mobilePreferencesAtom } from "../../state/preferences";
import {
  clearComposerDraft,
  clearComposerDraftContent,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import {
  enqueueThreadOutboxMessage,
  flattenQueuedThreadMessages,
  type QueuedThreadMessage,
} from "../../state/thread-outbox";
import { ThreadOutboxDrainWorker, useIsThreadOutboxHost } from "../../state/thread-outbox-worker";
import { useThreadOutboxMessages } from "../../state/use-thread-outbox";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { useVoicePreferences } from "../../state/voice-preferences";
import { CloudAuthProvider } from "../cloud/CloudAuthProvider";
import { AppearancePreferencesProvider } from "../settings/appearance/AppearancePreferencesProvider";
import { NewTaskFlowProvider, useNewTaskFlow } from "../threads/new-task-flow-provider";
import { readingAloudIdAtom, stopReadingAloud } from "../read-aloud/readAloud";
import {
  armNextReply,
  cancelNextReply,
  ReadAloudWorker,
  readNextReply,
  useWaitsForNextReply,
} from "../read-aloud/ReadAloudWorker";
import { resolveAssistantProject } from "./assistantProject";
import { lastOpenedThread } from "./assistantTargets";
import { AssistantTargetPicker, type AssistantTarget } from "./AssistantTargetPicker";
import {
  ContextPills,
  MachineButton,
  MachineList,
  ImageContextEditor,
  TextContextEditor,
  type ContextPillView,
  type PanelMachine,
} from "./AssistantPanelParts";
import {
  CONTEXT_PILL_ORDER,
  contextPillLabel,
  inlineContextText,
  isImageContextPill,
  locationText,
  joinMessageText,
  screenTextDocument,
  type ContextPillKind,
  type ImageContextPillKind,
  type TextContextPillKind,
} from "./contextPills";

const CONTEXT_PILL_TITLES: Record<ContextPillKind, string> = {
  sharedText: "Shared text",
  sharedImage: "Shared image",
  selection: "Selected text",
  screenshot: "Screenshot",
  screenText: "Screen text",
  link: "Link",
  recentPhoto: "Recent photo",
  location: "Location",
  clipboard: "Clipboard",
};

const IMAGE_CONTEXT_PILLS: ReadonlyArray<ImageContextPillKind> = [
  "sharedImage",
  "screenshot",
  "recentPhoto",
];

/** A photo older than this is not "recent": the panel offers only what was likely just taken. */
const RECENT_PHOTO_MAX_AGE_SECONDS = 15 * 60;

/**
 * Fork: the Android assistant panel. `AssistantActivity` renders this root over the app that
 * was on screen, with that screen's text and screenshot. It starts a new thread in the default
 * project; it never shows thread history.
 */
export function AssistantPanelRoot() {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <AppearancePreferencesProvider>
        <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
          <SafeAreaProvider>
            <AppServicesWhenAlone />
            <ReadAloudWorker />
            <NewTaskFlowProvider>
              <AssistantPanelForCapture />
            </NewTaskFlowProvider>
          </SafeAreaProvider>
        </KeyboardProvider>
      </AppearancePreferencesProvider>
    </RegistryContext.Provider>
  );
}

/**
 * The app root runs the relay sign-in and the outbox sender when it is mounted. On a cold
 * start only this panel is mounted, so it runs them until the app root mounts.
 */
function AppServicesWhenAlone() {
  if (!useIsThreadOutboxHost()) return null;
  return (
    <CloudAuthProvider>
      <ThreadOutboxDrainWorker />
    </CloudAuthProvider>
  );
}

type Phase =
  | { readonly type: "editing" }
  | { readonly type: "preparing" }
  | { readonly type: "sending"; readonly messageId: string; readonly threadRef: ScopedThreadRef }
  | { readonly type: "failed"; readonly message: string };

let latestCapture: AssistantCapture | null = null;

function subscribeToCapture(onChange: () => void) {
  const subscription = assistantNative?.addListener("onCapture", (capture) => {
    latestCapture = capture;
    onChange();
  });
  // The session can publish before this subscription starts.
  latestCapture = assistantNative?.getCapture() ?? null;
  onChange();
  return () => subscription?.remove();
}

/** Each press of the assistant button gets a fresh panel, so no draft carries over. */
function AssistantPanelForCapture() {
  const capture = useSyncExternalStore(subscribeToCapture, () => latestCapture);
  return <AssistantPanel key={capture?.id ?? "none"} capture={capture} />;
}

const DRAFT_RESTORE_MS = 60_000;

interface UnsentDraft {
  readonly text: string;
  readonly target: AssistantTarget | null;
  readonly savedAt: number;
}

/**
 * Fork: the text of a panel that closed without sending. A press within a minute gets it back.
 * Limit: it lives in memory, so it is lost when Android stops the app process. Revisit if the
 * draft must survive that.
 */
let unsentDraft: UnsentDraft | null = null;

function recentUnsentDraft(): UnsentDraft | null {
  return unsentDraft && Date.now() - unsentDraft.savedAt < DRAFT_RESTORE_MS ? unsentDraft : null;
}

function keepUnsentDraft(draft: Omit<UnsentDraft, "savedAt"> | null): void {
  unsentDraft = draft && draft.text.trim().length > 0 ? { ...draft, savedAt: Date.now() } : null;
}

/** Turns the panel input into the message text and the draft attachments. */
async function prepareAssistantMessage(input: {
  readonly text: string;
  readonly imageUris: ReadonlyArray<string>;
  readonly screenText: string | null;
  /** Undefined when the server takes no file uploads. */
  readonly maxUploadBytes: number | undefined;
}): Promise<{
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
}> {
  await waitForComposerDraftsLoaded();
  // A gallery photo is a content URI; attachments read plain files.
  const native = assistantNative;
  const files = await Promise.all(
    input.imageUris.map((uri) =>
      uri.startsWith("content:") && native ? native.copyToCache(uri) : Promise.resolve(uri),
    ),
  );
  const attachments: DraftComposerAttachment[] =
    files.length > 0
      ? [...(await convertPastedImagesToAttachments({ uris: files, existingCount: 0 }))]
      : [];
  const text = input.text.trim();
  if (!input.screenText) return { text, attachments };
  if (input.maxUploadBytes === undefined) {
    return { text: `${text}\n\n<screen>\n${input.screenText}\n</screen>`.trim(), attachments };
  }
  attachments.push(
    await createPastedTextComposerAttachment({
      text: input.screenText,
      name: "screen.txt",
      maxBytes: clampFileAttachmentUploadBytes(input.maxUploadBytes),
    }),
  );
  return { text, attachments };
}

function AssistantPanel(props: { readonly capture: AssistantCapture | null }) {
  const { capture } = props;
  const flow = useNewTaskFlow();
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const voice = useVoicePreferences();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const queuedMessages = useThreadOutboxMessages();
  const readingId = useAtomValue(readingAloudIdAtom);
  const threads = useNavigationThreadShells();
  const [restored] = useState(recentUnsentDraft);
  const [text, setText] = useState(restored?.text ?? "");
  const [pickedTarget, setPickedTarget] = useState<AssistantTarget | null>(
    restored?.target ?? null,
  );
  const [pickedEnvironmentId, setPickedEnvironmentId] = useState<EnvironmentId | null>(null);
  // The panel body shows one thing at a time, so it never grows past the composer.
  const [view, setView] = useState<"compose" | "target" | "machine" | ContextPillKind>("compose");
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  // A pill without an entry follows its default; a tap overrides it for this press.
  const [attachedChoice, setAttachedChoice] = useState<Partial<Record<ContextPillKind, boolean>>>(
    {},
  );
  const [editedText, setEditedText] = useState<Partial<Record<TextContextPillKind, string>>>({});
  const [annotatedImages, setAnnotatedImages] = useState<
    Partial<Record<ImageContextPillKind, string>>
  >({});
  const [recentPhoto, setRecentPhoto] = useState<RecentPhoto | null>(null);
  const [location, setLocation] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<{
    readonly available: boolean;
    readonly text: string | null;
  }>({ available: false, text: null });
  const [phase, setPhase] = useState<Phase>({ type: "editing" });
  const sentRef = useRef(false);
  // Kept as it changes, so the Home button or a new press keeps it too, not only Close.
  useEffect(() => {
    if (!sentRef.current) keepUnsentDraft({ text, target: pickedTarget });
  }, [text, pickedTarget]);
  const startedWithVoiceRef = useRef(false);
  const preferencesLoaded = AsyncResult.isSuccess(preferences);

  // A picked machine limits the defaults and the picker to its threads and projects.
  const machineProjects =
    pickedEnvironmentId === null
      ? projects
      : projects.filter((project) => project.environmentId === pickedEnvironmentId);
  const machineThreads =
    pickedEnvironmentId === null
      ? threads
      : threads.filter((thread) => thread.environmentId === pickedEnvironmentId);
  const defaultProject = AsyncResult.isSuccess(preferences)
    ? resolveAssistantProject({
        projects: machineProjects,
        chosen: voice.assistantProject,
        preferences: preferences.value,
        scratchWorkspaceRoot: (environmentId) =>
          serverConfigs.get(environmentId)?.scratchWorkspaceRoot,
      })
    : null;
  // The picked target wins. A picked thread is looked up again on each render, so a rename shows
  // and an archived or deleted thread falls back to a new thread.
  const defaultThread =
    voice.assistantTarget === "lastThread" ? lastOpenedThread(machineThreads) : null;
  const targetThread =
    pickedTarget === null
      ? defaultThread
      : pickedTarget.type === "thread"
        ? (threads.find(
            (thread) =>
              thread.environmentId === pickedTarget.thread.environmentId &&
              thread.id === pickedTarget.thread.id &&
              thread.archivedAt === null,
          ) ?? null)
        : null;
  const project = pickedTarget?.type === "project" ? pickedTarget.project : defaultProject;
  const target: AssistantTarget | null = targetThread
    ? { type: "thread", thread: targetThread }
    : project
      ? { type: "project", project }
      : null;
  const selectedProject = flow.selectedProject;
  const selectProject = useEffectEvent(() => {
    if (
      project &&
      (selectedProject?.environmentId !== project.environmentId ||
        selectedProject.id !== project.id)
    ) {
      flow.setProject(project);
    }
  });
  const projectKey = project ? `${project.environmentId}:${project.id}` : null;
  useEffect(() => {
    if (projectKey !== null) selectProject();
  }, [projectKey]);

  const draftKey = flow.draftKey;
  // The outbox hands the message to the server, then the panel opens the thread, reads the
  // first reply aloud, or closes. These states follow the outbox and the player.
  const sendingThread = phase.type === "sending" ? phase.threadRef : null;
  const delivered =
    phase.type === "sending" &&
    !flattenQueuedThreadMessages(queuedMessages).some(
      (message) => message.messageId === phase.messageId,
    );
  const readsReply = voice.assistantSpeakFirstReply && !voice.assistantOpenThread;
  const waitsForReply = useWaitsForNextReply(readsReply ? sendingThread : null);
  const afterDelivery: "open" | "wait" | "read" | "close" | null = !delivered
    ? null
    : voice.assistantOpenThread
      ? "open"
      : !readsReply
        ? "close"
        : waitsForReply
          ? "wait"
          : readingId !== null
            ? "read"
            : "close";
  const waitingThread = afterDelivery === "wait" ? sendingThread : null;
  const close = () => {
    if (!sentRef.current && draftKey) clearComposerDraft(draftKey);
    // The minute to get the text back starts at close.
    if (!sentRef.current) keepUnsentDraft({ text, target: pickedTarget });
    // Closing while the reply is pending drops the request, so it is not read later.
    if (waitingThread) cancelNextReply(waitingThread);
    assistantNative?.close();
  };
  // Inside a picker or an editor, Back, the close button and a tap outside return to the message.
  const back = () => {
    if (view !== "compose") setView("compose");
    else close();
  };
  const onBackPress = useEffectEvent(() => {
    back();
    return true;
  });
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", onBackPress);
    return () => subscription.remove();
  }, []);

  const finishDelivery = useEffectEvent((action: "open" | "close", threadRef: ScopedThreadRef) => {
    if (action === "open") {
      void Linking.openURL(
        Linking.createURL(
          `threads/${encodeURIComponent(threadRef.environmentId)}/${encodeURIComponent(threadRef.threadId)}`,
        ),
      );
    }
    assistantNative?.close();
  });
  useEffect(() => {
    if (delivered && sendingThread) armNextReply(sendingThread);
  }, [delivered, sendingThread]);
  useEffect(() => {
    if ((afterDelivery === "open" || afterDelivery === "close") && sendingThread) {
      finishDelivery(afterDelivery, sendingThread);
    }
  }, [afterDelivery, sendingThread]);

  // Hidden until it is known to hold text: reading the clipboard shows a system notice.
  useEffect(() => {
    let cancelled = false;
    void Clipboard.hasStringAsync().then(
      (available) => {
        if (!cancelled) setClipboard((current) => ({ ...current, available }));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const readClipboard = async () => {
    const read = await settlePromise(() => Clipboard.getStringAsync());
    const value = AsyncResult.isSuccess(read) ? read.value : "";
    setClipboard({ available: value.length > 0, text: value });
  };
  // Opt-in pills from Settings > Voice. Each asks the phone only when it is turned on.
  const wantsRecentPhoto = voice.assistantRecentPhoto;
  const wantsLocation = voice.assistantLocation;
  // A photo reaches the gallery a few seconds after it is taken, so the pill appears when it does.
  useEffect(() => {
    const native = assistantNative;
    if (!wantsRecentPhoto || !native) return;
    let cancelled = false;
    const query = () =>
      void native.recentPhoto(RECENT_PHOTO_MAX_AGE_SECONDS).then(
        (photo) => {
          if (!cancelled) setRecentPhoto(photo);
        },
        () => {},
      );
    query();
    const subscription = native.addListener("onPhotosChanged", query);
    native.watchPhotos(true);
    return () => {
      cancelled = true;
      subscription.remove();
      native.watchPhotos(false);
    };
  }, [wantsRecentPhoto]);
  // The coordinates come at once; the place name follows, since its lookup can take the network.
  useEffect(() => {
    const native = assistantNative;
    if (!wantsLocation || !native) return;
    let cancelled = false;
    void native.lastLocation().then(
      (last) => {
        if (cancelled || !last) return;
        setLocation(locationText({ ...last, place: null }));
        void native.placeName(last.latitude, last.longitude).then(
          (place) => {
            if (!cancelled && place) setLocation(locationText({ ...last, place }));
          },
          () => {},
        );
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [wantsLocation]);
  const originalContext: Record<ContextPillKind, string | null> = {
    sharedText: capture?.sharedText ?? null,
    sharedImage: capture?.sharedImageUri ?? null,
    selection: capture?.selectedText ?? null,
    screenshot: capture?.screenshotUri ?? null,
    screenText: capture?.screenText ?? null,
    link: capture?.webUri ?? null,
    recentPhoto: wantsRecentPhoto ? (recentPhoto?.uri ?? null) : null,
    location: wantsLocation ? location : null,
    clipboard: clipboard.available ? (clipboard.text ?? "") : null,
  };
  const defaultAttached: Record<ContextPillKind, boolean> = {
    // The user handed these over on purpose, so they go along unless left out.
    sharedText: true,
    sharedImage: true,
    selection: true,
    link: true,
    screenshot: voice.assistantAttachScreenshot,
    screenText: voice.assistantAttachScreenText,
    // Private, so they wait for a tap.
    recentPhoto: false,
    location: false,
    clipboard: false,
  };
  const isAttached = (kind: ContextPillKind) => attachedChoice[kind] ?? defaultAttached[kind];
  const contextValue = (kind: TextContextPillKind) =>
    editedText[kind] ?? originalContext[kind] ?? "";
  const attachedText = (kind: TextContextPillKind) =>
    isAttached(kind) && originalContext[kind] !== null ? contextValue(kind) : null;
  const imageUri = (kind: ImageContextPillKind) => annotatedImages[kind] ?? originalContext[kind];
  const togglePill = async (kind: ContextPillKind) => {
    const next = !isAttached(kind);
    if (kind === "clipboard" && next && clipboard.text === null) await readClipboard();
    setAttachedChoice((current) => ({ ...current, [kind]: next }));
  };
  const openPill = async (kind: ContextPillKind) => {
    if (kind === "clipboard" && clipboard.text === null) await readClipboard();
    setView(kind);
  };
  const pills: ReadonlyArray<ContextPillView> = CONTEXT_PILL_ORDER.filter(
    (kind) => originalContext[kind] !== null,
  ).map((kind) => ({
    kind,
    label: isImageContextPill(kind)
      ? contextPillLabel(kind, "")
      : kind === "clipboard"
        ? contextPillLabel(kind, "")
        : contextPillLabel(kind, contextValue(kind)),
    attached: isAttached(kind),
    thumbnailUri: isImageContextPill(kind) ? imageUri(kind) : null,
  }));
  const attachedImageUris = IMAGE_CONTEXT_PILLS.filter((kind) => isAttached(kind))
    .map(imageUri)
    .filter((uri) => uri !== null && uri !== undefined);
  const attachedScreenText = attachedText("screenText");
  const screenText = attachedScreenText?.trim()
    ? screenTextDocument(capture?.sourcePackage ?? null, attachedScreenText)
    : null;
  const inlineContext = inlineContextText({
    sharedText: attachedText("sharedText"),
    selection: attachedText("selection"),
    link: attachedText("link"),
    location: attachedText("location"),
    clipboard: attachedText("clipboard"),
  });
  const annotate = async (kind: ImageContextPillKind, strokes: ReadonlyArray<AnnotationStroke>) => {
    const base = imageUri(kind);
    const native = assistantNative;
    if (!base || !native) return;
    const result = await settlePromise(() => native.annotateImage(base, strokes));
    if (AsyncResult.isFailure(result)) return fail(result, "The image could not be marked up.");
    setAnnotatedImages((current) => ({ ...current, [kind]: result.value }));
    setAttachedChoice((current) => ({ ...current, [kind]: true }));
    setView("compose");
  };
  const targetEnvironmentId = targetThread?.environmentId ?? selectedProject?.environmentId;
  const environmentLabel = (environmentId: string) =>
    connectedEnvironments.find((candidate) => candidate.environmentId === environmentId)
      ?.environmentLabel ?? null;
  const connected =
    connectedEnvironments.find((candidate) => candidate.environmentId === targetEnvironmentId)
      ?.connectionState === "connected";
  const busy = phase.type !== "editing" && phase.type !== "failed";
  const machines: ReadonlyArray<PanelMachine> = connectedEnvironments
    .filter((environment) => environment.isEnabled)
    .map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.environmentLabel,
      kind: resolveEnvironmentMachineKind(serverConfigs.get(environment.environmentId) ?? null),
      connected: environment.connectionState === "connected",
    }));
  const targetMachine = machines.find((machine) => machine.environmentId === targetEnvironmentId);
  const ready = !busy && (targetThread !== null || (selectedProject !== null && draftKey !== null));
  const hasContent = (messageText: string) =>
    joinMessageText(messageText, inlineContext).length > 0 ||
    attachedImageUris.length > 0 ||
    screenText !== null;

  const fail = (result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) => {
    const error = squashAtomCommandFailure(result);
    setPhase({ type: "failed", message: error instanceof Error ? error.message : fallback });
  };

  const send = async (messageText: string) => {
    if (!ready || targetEnvironmentId === undefined || !hasContent(messageText)) return;
    setPhase({ type: "preparing" });
    const capabilities = serverConfigs.get(targetEnvironmentId)?.environment.capabilities;
    const prepared = await settlePromise(() =>
      prepareAssistantMessage({
        text: joinMessageText(messageText, inlineContext),
        imageUris: attachedImageUris,
        screenText,
        maxUploadBytes:
          capabilities?.attachmentUploads === true
            ? capabilities.fileAttachments?.maxUploadBytes
            : undefined,
      }),
    );
    if (AsyncResult.isFailure(prepared)) return fail(prepared, "The screen could not be attached.");
    const metadata = makeTurnCommandMetadata();
    let message: QueuedThreadMessage | null;
    if (targetThread) {
      // Queued, so the message becomes its own run after any running one: the panel can then
      // read the reply of exactly this message.
      message = {
        environmentId: targetThread.environmentId,
        threadId: targetThread.id,
        messageId: MessageId.make(metadata.messageId),
        commandId: CommandId.make(metadata.commandId),
        text: prepared.value.text,
        attachments: prepared.value.attachments,
        dispatchMode: "queue",
        createdAt: metadata.createdAt,
      };
    } else {
      flow.setPrompt(prepared.value.text);
      flow.replaceAttachments(prepared.value.attachments);
      message = flow.buildPendingTaskMessage(metadata, {
        currentCheckoutBranch: connected ? flow.currentCheckoutBranchName : null,
      });
    }
    if (!message) {
      setPhase({ type: "failed", message: "No model is available for this project yet." });
      return;
    }
    const queuedMessage = message;
    const threadRef = { environmentId: message.environmentId, threadId: message.threadId };
    if (voice.assistantSpeakFirstReply) {
      readNextReply({ threadRef, userMessageId: message.messageId });
    }
    const queued = await settlePromise(() => enqueueThreadOutboxMessage(queuedMessage));
    if (AsyncResult.isFailure(queued)) {
      cancelNextReply(threadRef);
      return fail(queued, "The message could not be queued.");
    }
    sentRef.current = true;
    keepUnsentDraft(null);
    if (draftKey && targetThread) {
      // The new thread draft held nothing for a message to an existing thread.
      clearComposerDraft(draftKey);
    } else if (draftKey) {
      clearComposerDraftContent(draftKey, {
        clearModelSelection: true,
        clearWorkspaceSelection: true,
        deferAttachmentCleanup: true,
      });
    }
    setPhase({ type: "sending", messageId: message.messageId, threadRef });
  };

  const speak = async () => {
    const spoken = await settlePromise(
      async () => (await assistantNative?.recognizeSpeech()) ?? null,
    );
    if (AsyncResult.isFailure(spoken)) return fail(spoken, "Speech input failed.");
    const words = spoken.value;
    if (!words) return;
    const next = text.trim() ? `${text.trimEnd()} ${words}` : words;
    setText(next);
    // The dialog can take long, so this reads the state after it closed. When the target is not
    // ready yet on a cold start, the text waits for a tap.
    const latest = latestRef.current;
    if (voice.assistantSendAfterVoice && latest.ready) await latest.send(next);
  };
  const latestRef = useRef({ ready, send });
  useEffect(() => {
    latestRef.current = { ready, send };
  });

  const startWithVoice = useEffectEvent(() => {
    if (voice.assistantInput === "voice") void speak();
  });
  useEffect(() => {
    if (!preferencesLoaded || startedWithVoiceRef.current) return;
    startedWithVoiceRef.current = true;
    startWithVoice();
  }, [preferencesLoaded]);

  // Above the keyboard the system inset is gone, so the row sits right on its edge.
  const bottomPadding = keyboardVisible ? 8 : insets.bottom + 12;
  const typed = text.trim().length > 0;
  const targetLabel = targetThread
    ? targetThread.title.trim() || "Untitled thread"
    : project
      ? `New thread · ${project.title}`
      : pickedEnvironmentId !== null && machineProjects.length === 0
        ? "No projects on this machine"
        : "Loading projects…";
  const status = (() => {
    if (afterDelivery === "wait") return "Waiting for the reply…";
    if (afterDelivery === "read") return "Reading the reply aloud";
    switch (phase.type) {
      case "sending":
        return connected ? "Sending…" : "Queued. It sends when the server connects.";
      default:
        return connected ? "Connected" : "Not connected. The message waits in the outbox.";
    }
  })();

  return (
    <View className="flex-1 justify-end">
      <Pressable
        accessibilityLabel={view === "compose" ? "Close" : "Back to the message"}
        className="absolute inset-0 bg-black/40"
        onPress={back}
      />
      <KeyboardAvoidingView behavior="padding">
        <View
          className="gap-3 rounded-t-3xl bg-sheet px-4 pt-4"
          style={{ paddingBottom: bottomPadding }}
        >
          <View className="flex-row items-center justify-between gap-2">
            {machines.length > 1 && targetMachine ? (
              <MachineButton
                machine={targetMachine}
                expanded={view === "machine"}
                disabled={busy}
                onPress={() =>
                  setView((current) => (current === "machine" ? "compose" : "machine"))
                }
              />
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${targetLabel}. Change where to send`}
              accessibilityState={{ expanded: view === "target", disabled: busy }}
              className="flex-1"
              disabled={busy}
              onPress={() => setView((current) => (current === "target" ? "compose" : "target"))}
            >
              <View className="flex-row items-center gap-1">
                <Text textRole="body" className="shrink font-medium" numberOfLines={1}>
                  {targetLabel}
                </Text>
                <SymbolView
                  name={view === "target" ? "chevron.up" : "chevron.down"}
                  size={14}
                  tintColorClassName="accent-foreground-muted"
                />
              </View>
              <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                {status}
              </Text>
            </Pressable>
            {afterDelivery === "read" ? (
              <IconButton
                accessibilityLabel="Stop reading aloud"
                icon="stop.fill"
                onPress={stopReadingAloud}
              />
            ) : null}
            <IconButton
              accessibilityLabel={view === "compose" ? "Close" : "Back to the message"}
              icon="xmark"
              onPress={back}
            />
          </View>

          {view === "machine" ? (
            <MachineList
              machines={machines}
              selected={targetEnvironmentId}
              onPick={(environmentId) => {
                setPickedEnvironmentId(environmentId);
                // A target on another machine no longer fits; the machine's default takes over.
                if (environmentId !== targetEnvironmentId) setPickedTarget(null);
                setView("compose");
              }}
            />
          ) : view === "target" ? (
            <AssistantTargetPicker
              target={target}
              threads={machineThreads}
              projects={machineProjects}
              environmentLabel={environmentLabel}
              onPick={(picked) => {
                setPickedTarget(picked);
                setView("compose");
              }}
            />
          ) : view !== "compose" && isImageContextPill(view) ? (
            <ImageContextEditor
              title={CONTEXT_PILL_TITLES[view]}
              uri={imageUri(view) ?? ""}
              imageWidth={view === "screenshot" ? (capture?.screenshotWidth ?? 0) : 0}
              imageHeight={view === "screenshot" ? (capture?.screenshotHeight ?? 0) : 0}
              annotated={annotatedImages[view] !== undefined}
              onSave={(strokes) => void annotate(view, strokes)}
              onReset={() =>
                setAnnotatedImages((current) => {
                  const next = { ...current };
                  delete next[view];
                  return next;
                })
              }
              onDone={() => setView("compose")}
            />
          ) : view !== "compose" ? (
            <TextContextEditor
              title={CONTEXT_PILL_TITLES[view]}
              subtitle={view === "screenText" ? (capture?.sourcePackage ?? null) : null}
              value={contextValue(view)}
              edited={editedText[view] !== undefined}
              onChange={(value) => setEditedText((current) => ({ ...current, [view]: value }))}
              onReset={() =>
                setEditedText((current) => {
                  const next = { ...current };
                  delete next[view];
                  return next;
                })
              }
              onDone={() => setView("compose")}
            />
          ) : (
            <>
              <ContextPills
                pills={pills}
                onToggle={(kind) => void togglePill(kind)}
                onOpen={(kind) => void openPill(kind)}
              />
              {phase.type === "failed" ? (
                <Text className="text-sm text-danger-foreground">{phase.message}</Text>
              ) : null}
              {/*
                One button in one place, next to the thumb: the mic while the field is empty,
                send once there is text. While typing, a small mic in the field adds speech.
              */}
              <View className="flex-row items-end gap-2">
                <View className="flex-1">
                  <AppTextInput
                    autoFocus={voice.assistantInput === "text"}
                    editable={!busy}
                    multiline
                    className={typed ? "max-h-40 pr-11" : "max-h-40"}
                    placeholder={targetThread ? "Message" : "What should the agent do?"}
                    value={text}
                    onChangeText={setText}
                  />
                  {typed ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Add speech"
                      disabled={busy}
                      hitSlop={6}
                      className="absolute bottom-0 right-0 h-13.5 w-11 items-center justify-center"
                      onPress={() => void speak()}
                    >
                      <SymbolView
                        name="mic"
                        size={18}
                        tintColorClassName="accent-foreground-muted"
                      />
                    </Pressable>
                  ) : null}
                </View>
                {typed ? (
                  <IconButton
                    accessibilityLabel={targetThread ? "Send" : "Start thread"}
                    icon="arrow.up"
                    variant="primary"
                    disabled={!ready || !hasContent(text)}
                    onPress={() => void send(text)}
                  />
                ) : (
                  <IconButton
                    accessibilityLabel="Speak"
                    icon="mic"
                    variant="primary"
                    disabled={busy}
                    onPress={() => void speak()}
                  />
                )}
              </View>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
