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
import * as ImagePicker from "expo-image-picker";
import * as Linking from "expo-linking";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { BackHandler, PermissionsAndroid, Platform, Pressable, View } from "react-native";
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
  pickComposerFiles,
  type DraftComposerAttachment,
} from "../../lib/composerImages";
import { withCameraLauncher } from "../../lib/forkComposerCamera";
import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import {
  assistantNative,
  type AnnotationStroke,
  type AssistantCapture,
  type ImageCrop,
  type RecentPhoto,
} from "../../native/assistant";
import { appAtomRegistry } from "../../state/atom-registry";
import { useNavigationThreadShells, useProjects, useServerConfigs } from "../../state/entities";
import { mobilePreferencesAtom } from "../../state/preferences";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  clearComposerDraft,
  clearComposerDraftContent,
  getComposerDraftSnapshot,
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
import { AssistantConversation } from "./AssistantConversation";
import { AssistantTargetPicker, type AssistantTarget } from "./AssistantTargetPicker";
import {
  ContextPills,
  EdgeGlow,
  FileContextView,
  ImageContextEditor,
  MachineButton,
  MachineList,
  OpenInAppHandle,
  PanelMenu,
  TextContextEditor,
  type ContextPillView,
  type PanelMachine,
  type PanelMenuItem,
} from "./AssistantPanelParts";
import {
  CONTEXT_PILL_ORDER,
  contextPillLabel,
  inlineContextText,
  isImageContextPill,
  locationText,
  joinMessageText,
  screenTextDocument,
  type FoundContextPillKind,
  type ImageContextPillKind,
  type TextContextPillKind,
} from "./contextPills";

const CONTEXT_PILL_TITLES: Record<FoundContextPillKind, string> = {
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

const FOUND_IMAGE_PILLS: ReadonlyArray<Exclude<ImageContextPillKind, "photo">> = [
  "sharedImage",
  "screenshot",
  "recentPhoto",
];

const isFoundPill = (id: string): id is FoundContextPillKind =>
  CONTEXT_PILL_ORDER.some((kind) => kind === id);

/** A photo older than this is not "recent": the panel offers only what was likely just taken. */
const RECENT_PHOTO_MAX_AGE_SECONDS = 15 * 60;

// Android 13 split photo access out of storage access.
const PHOTO_PERMISSION =
  Platform.OS === "android" && Platform.Version >= 33
    ? PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES
    : PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE;

/**
 * Fork: the Android assistant panel. `AssistantActivity` renders this root over the app that
 * was on screen, with that screen's text and screenshot. It sends to a new or an existing
 * thread and shows only the replies to what it sent, never the thread history.
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
  | {
      readonly type: "sending";
      readonly messageId: MessageId;
      readonly threadRef: ScopedThreadRef;
    }
  | { readonly type: "failed"; readonly message: string };

/** The panel body shows one thing at a time, so it never grows past the composer. */
type PanelView =
  | { readonly type: "compose" }
  | { readonly type: "target" }
  | { readonly type: "machine" }
  | { readonly type: "add" }
  | { readonly type: "pill"; readonly id: string };

interface SentMessage {
  readonly messageId: MessageId;
  readonly text: string;
  readonly threadRef: ScopedThreadRef;
}

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
  readonly files: ReadonlyArray<DraftComposerAttachment>;
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
  const imageFiles = await Promise.all(
    input.imageUris.map((uri) =>
      uri.startsWith("content:") && native ? native.copyToCache(uri) : Promise.resolve(uri),
    ),
  );
  const attachments: DraftComposerAttachment[] =
    imageFiles.length > 0
      ? [...(await convertPastedImagesToAttachments({ uris: imageFiles, existingCount: 0 }))]
      : [];
  attachments.push(...input.files);
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

function threadUrl(threadRef: ScopedThreadRef): string {
  return Linking.createURL(
    `threads/${encodeURIComponent(threadRef.environmentId)}/${encodeURIComponent(threadRef.threadId)}`,
  );
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
  const [view, setView] = useState<PanelView>({ type: "compose" });
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  // A pill without an entry follows its default; a tap overrides it for this press.
  const [attachedChoice, setAttachedChoice] = useState<Partial<Record<string, boolean>>>({});
  const [editedText, setEditedText] = useState<Partial<Record<TextContextPillKind, string>>>({});
  const [editedImages, setEditedImages] = useState<Partial<Record<string, string>>>({});
  const [addedPhotos, setAddedPhotos] = useState<
    ReadonlyArray<{ readonly id: string; readonly uri: string }>
  >([]);
  const [addedFiles, setAddedFiles] = useState<ReadonlyArray<DraftComposerAttachment>>([]);
  // Pills the settings leave off can still be asked for once from "+".
  const [askedFor, setAskedFor] = useState({ recentPhoto: false, location: false });
  const [recentPhoto, setRecentPhoto] = useState<RecentPhoto | null>(null);
  const [location, setLocation] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<{
    readonly available: boolean;
    readonly text: string | null;
  }>({ available: false, text: null });
  const [phase, setPhase] = useState<Phase>({ type: "editing" });
  const [sent, setSent] = useState<ReadonlyArray<SentMessage>>([]);
  // True once the new thread draft belongs to a sent message or to the app, so closing keeps it.
  const flowDraftHandedOffRef = useRef(false);
  const startedWithVoiceRef = useRef(false);
  const preferencesLoaded = AsyncResult.isSuccess(preferences);
  const afterSend = voice.assistantAfterSend;

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

  // The first message starts the conversation. Its thread exists once the outbox delivered it.
  const outboxMessageIds = new Set(
    flattenQueuedThreadMessages(queuedMessages).map((message) => message.messageId),
  );
  const firstSent = sent[0];
  const conversationRef =
    firstSent && !outboxMessageIds.has(firstSent.messageId) ? firstSent.threadRef : null;
  const findThread = (ref: { readonly environmentId: EnvironmentId; readonly threadId: string }) =>
    threads.find(
      (thread) =>
        thread.environmentId === ref.environmentId &&
        thread.id === ref.threadId &&
        thread.archivedAt === null,
    ) ?? null;

  // A follow-up goes to the conversation thread. Otherwise the picked target wins. A picked
  // thread is looked up again on each render, so a rename shows and an archived or deleted
  // thread falls back to a new thread.
  const defaultThread =
    voice.assistantTarget === "lastThread" ? lastOpenedThread(machineThreads) : null;
  const targetThread = conversationRef
    ? findThread(conversationRef)
    : pickedTarget === null
      ? defaultThread
      : pickedTarget.type === "thread"
        ? findThread({
            environmentId: pickedTarget.thread.environmentId,
            threadId: pickedTarget.thread.id,
          })
        : null;
  const project = pickedTarget?.type === "project" ? pickedTarget.project : defaultProject;
  const target: AssistantTarget | null = targetThread
    ? { type: "thread", thread: targetThread }
    : project
      ? { type: "project", project }
      : null;
  const draftTarget: AssistantTarget | null = targetThread
    ? { type: "thread", thread: targetThread }
    : pickedTarget;
  // Kept as it changes, so the Home button or a new press keeps it too, not only Close.
  useEffect(() => {
    keepUnsentDraft({ text, target: draftTarget });
  }, [text, draftTarget]);
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
  // The outbox hands the message to the server. Then the panel opens the thread, reads the
  // reply aloud, shows the reply, or closes. These states follow the outbox and the player.
  const sendingThread = phase.type === "sending" ? phase.threadRef : null;
  const delivered = phase.type === "sending" && !outboxMessageIds.has(phase.messageId);
  const readsReply = voice.assistantSpeakFirstReply && afterSend !== "openThread";
  const waitsForReply = useWaitsForNextReply(readsReply ? sendingThread : null);
  const afterDelivery: "open" | "wait" | "read" | "stay" | "close" | null = !delivered
    ? null
    : afterSend === "openThread"
      ? "open"
      : readsReply && waitsForReply
        ? "wait"
        : readsReply && readingId !== null
          ? "read"
          : afterSend === "stay"
            ? "stay"
            : "close";
  const waitingThread = afterDelivery === "wait" ? sendingThread : null;
  const close = () => {
    if (!flowDraftHandedOffRef.current && draftKey) clearComposerDraft(draftKey);
    // The minute to get the text back starts at close.
    keepUnsentDraft({ text, target: draftTarget });
    // Closing while the reply is pending drops the request, so it is not read later.
    if (waitingThread) cancelNextReply(waitingThread);
    assistantNative?.close();
  };
  // Inside a picker or an editor, Back, the close button and a tap outside return to the message.
  const back = () => {
    if (view.type !== "compose") setView({ type: "compose" });
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
    if (action === "open") void Linking.openURL(threadUrl(threadRef));
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
  // Opt-in pills from Settings > Voice, or asked for from "+". Each asks the phone only then.
  const wantsRecentPhoto = voice.assistantRecentPhoto || askedFor.recentPhoto;
  const wantsLocation = voice.assistantLocation || askedFor.location;
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
  const originalContext: Record<FoundContextPillKind, string | null> = {
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
  const defaultAttached: Record<FoundContextPillKind, boolean> = {
    // The user handed these over on purpose, so they go along unless left out.
    sharedText: true,
    sharedImage: true,
    selection: true,
    link: true,
    screenshot: voice.assistantAttachScreenshot,
    screenText: voice.assistantAttachScreenText,
    // Private, so they wait for a tap, unless they were asked for from "+".
    recentPhoto: askedFor.recentPhoto,
    location: askedFor.location,
    clipboard: false,
  };
  // A photo or a file from "+" was picked on purpose, so it starts attached.
  const isAttached = (id: string) =>
    attachedChoice[id] ?? (isFoundPill(id) ? defaultAttached[id] : true);
  const contextValue = (kind: TextContextPillKind) =>
    editedText[kind] ?? originalContext[kind] ?? "";
  const attachedText = (kind: TextContextPillKind) =>
    isAttached(kind) && originalContext[kind] !== null ? contextValue(kind) : null;
  const foundImageUri = (kind: Exclude<ImageContextPillKind, "photo">) =>
    editedImages[kind] ?? originalContext[kind];
  const togglePill = async (id: string) => {
    const next = !isAttached(id);
    if (id === "clipboard" && next && clipboard.text === null) await readClipboard();
    setAttachedChoice((current) => ({ ...current, [id]: next }));
  };
  const openPill = async (id: string) => {
    if (id === "clipboard" && clipboard.text === null) await readClipboard();
    setView({ type: "pill", id });
  };
  const foundPills: ReadonlyArray<ContextPillView> = CONTEXT_PILL_ORDER.filter(
    (kind) => originalContext[kind] !== null,
  ).map((kind) => ({
    id: kind,
    kind,
    label:
      isImageContextPill(kind) || kind === "clipboard"
        ? contextPillLabel(kind, "")
        : contextPillLabel(kind, contextValue(kind)),
    attached: isAttached(kind),
    thumbnailUri:
      kind === "sharedImage" || kind === "screenshot" || kind === "recentPhoto"
        ? foundImageUri(kind)
        : null,
  }));
  const pills: ReadonlyArray<ContextPillView> = [
    ...foundPills,
    ...addedPhotos.map((photo) => ({
      id: photo.id,
      kind: "photo" as const,
      label: contextPillLabel("photo", ""),
      attached: isAttached(photo.id),
      thumbnailUri: editedImages[photo.id] ?? photo.uri,
    })),
    ...addedFiles.map((file) => ({
      id: file.id,
      kind: "file" as const,
      label: contextPillLabel("file", file.name),
      attached: isAttached(file.id),
      thumbnailUri: null,
    })),
  ];
  const attachedImageUris = [
    ...FOUND_IMAGE_PILLS.filter((kind) => isAttached(kind)).map(foundImageUri),
    ...addedPhotos
      .filter((photo) => isAttached(photo.id))
      .map((photo) => editedImages[photo.id] ?? photo.uri),
  ].filter((uri) => uri !== null && uri !== undefined);
  const attachedFiles = addedFiles.filter((file) => isAttached(file.id));
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
  const editImage = async (
    id: string,
    base: string,
    strokes: ReadonlyArray<AnnotationStroke>,
    crop: ImageCrop | null,
  ) => {
    const native = assistantNative;
    if (!native) return;
    const result = await settlePromise(() => native.editImage(base, strokes, crop));
    if (AsyncResult.isFailure(result)) return fail(result, "The image could not be edited.");
    setEditedImages((current) => ({ ...current, [id]: result.value }));
    setAttachedChoice((current) => ({ ...current, [id]: true }));
    setView({ type: "compose" });
  };
  const resetImage = (id: string) =>
    setEditedImages((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  const targetEnvironmentId = targetThread?.environmentId ?? selectedProject?.environmentId;
  const environmentLabel = (environmentId: string) =>
    connectedEnvironments.find((candidate) => candidate.environmentId === environmentId)
      ?.environmentLabel ?? null;
  const connected =
    connectedEnvironments.find((candidate) => candidate.environmentId === targetEnvironmentId)
      ?.connectionState === "connected";
  const capabilities =
    targetEnvironmentId === undefined
      ? undefined
      : serverConfigs.get(targetEnvironmentId)?.environment.capabilities;
  const maxUploadBytes =
    capabilities?.attachmentUploads === true
      ? capabilities.fileAttachments?.maxUploadBytes
      : undefined;
  // While the panel stays, the next message can follow once the server took the last one.
  const busy =
    phase.type === "preparing" ||
    (phase.type === "sending" && (afterSend !== "stay" || !delivered));
  const machines: ReadonlyArray<PanelMachine> = connectedEnvironments
    .filter((environment) => environment.isEnabled)
    .map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.environmentLabel,
      kind: resolveEnvironmentMachineKind(serverConfigs.get(environment.environmentId) ?? null),
      connected: environment.connectionState === "connected",
    }));
  const targetMachine = machines.find((machine) => machine.environmentId === targetEnvironmentId);
  // Until the conversation thread is listed, a reply waits: a new thread target would split it.
  const conversationPending = conversationRef !== null && targetThread === null;
  const ready =
    !busy &&
    !conversationPending &&
    (targetThread !== null || (selectedProject !== null && draftKey !== null));
  const hasContent = (messageText: string) =>
    joinMessageText(messageText, inlineContext).length > 0 ||
    attachedImageUris.length > 0 ||
    attachedFiles.length > 0 ||
    screenText !== null;

  const fail = (result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) => {
    const error = squashAtomCommandFailure(result);
    setPhase({ type: "failed", message: error instanceof Error ? error.message : fallback });
  };

  const prepare = (messageText: string) => {
    if (attachedFiles.length > 0 && maxUploadBytes === undefined) {
      return Promise.reject(new Error("This server takes no files. Leave the files out."));
    }
    return prepareAssistantMessage({
      text: joinMessageText(messageText, inlineContext),
      imageUris: attachedImageUris,
      files: attachedFiles,
      screenText,
      maxUploadBytes,
    });
  };

  const send = async (messageText: string) => {
    if (!ready || targetEnvironmentId === undefined || !hasContent(messageText)) return;
    setPhase({ type: "preparing" });
    const prepared = await settlePromise(() => prepare(messageText));
    if (AsyncResult.isFailure(prepared))
      return fail(prepared, "The context could not be attached.");
    const metadata = makeTurnCommandMetadata();
    let message: QueuedThreadMessage | null;
    if (targetThread) {
      // Queued, so the message becomes its own run after any running one: the panel can then
      // show and read the reply of exactly this message.
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
    flowDraftHandedOffRef.current = true;
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
    // The context went with this message; a follow-up carries only what is picked again.
    setText("");
    setAttachedChoice(Object.fromEntries(pills.map((pill) => [pill.id, false])));
    setAddedPhotos([]);
    setAddedFiles([]);
    setSent((current) => [
      ...current,
      { messageId: queuedMessage.messageId, text: messageText.trim(), threadRef },
    ]);
    setPhase({ type: "sending", messageId: message.messageId, threadRef });
  };

  /**
   * Continues in the app with what the panel holds: a thread gets it in its composer, a new
   * thread opens its draft screen with it.
   */
  const openInApp = async () => {
    if (busy || conversationPending) return;
    const content = hasContent(text) ? await settlePromise(() => prepare(text)) : null;
    if (content && AsyncResult.isFailure(content)) {
      return fail(content, "The context could not be attached.");
    }
    const prepared = content?.value ?? null;
    let url: string | null = null;
    if (targetThread) {
      const threadDraftKey = scopedThreadKey(targetThread.environmentId, targetThread.id);
      if (prepared?.text) {
        const existing = getComposerDraftSnapshot(threadDraftKey).text;
        appendComposerDraftText(
          threadDraftKey,
          existing.trim() ? `\n\n${prepared.text}` : prepared.text,
        );
      }
      // Overflow is kept: the panel closes, so a rejected attachment would be lost.
      if (prepared) {
        appendComposerDraftAttachments(threadDraftKey, prepared.attachments, {
          allowOverflow: true,
        });
      }
      url = threadUrl({ environmentId: targetThread.environmentId, threadId: targetThread.id });
      // The new thread draft stays unused, as when the panel closes.
      if (draftKey && !flowDraftHandedOffRef.current) clearComposerDraft(draftKey);
    } else if (draftKey) {
      if (prepared) {
        flow.setPrompt(prepared.text);
        flow.replaceAttachments(prepared.attachments);
      }
      flowDraftHandedOffRef.current = true;
      url = Linking.createURL("new/draft", { queryParams: { draftId: draftKey } });
    }
    if (url === null) return;
    keepUnsentDraft(null);
    setText("");
    void Linking.openURL(url);
    assistantNative?.close();
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

  /** Asks for the access a pill needs. A refusal shows why the pill did not appear. */
  const askForPill = async (kind: "recentPhoto" | "location") => {
    setView({ type: "compose" });
    const native = assistantNative;
    if (!native) return;
    const permission =
      kind === "recentPhoto"
        ? PHOTO_PERMISSION
        : PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION;
    const granted = await settlePromise(() => PermissionsAndroid.request(permission));
    if (!AsyncResult.isSuccess(granted) || granted.value !== PermissionsAndroid.RESULTS.GRANTED) {
      setPhase({
        type: "failed",
        message: `Allow ${kind === "recentPhoto" ? "photo" : "location"} access for T3 Code in Android settings.`,
      });
      return;
    }
    const found =
      kind === "recentPhoto"
        ? await settlePromise(
            async () => (await native.recentPhoto(RECENT_PHOTO_MAX_AGE_SECONDS)) !== null,
          )
        : await settlePromise(async () => (await native.lastLocation()) !== null);
    if (!AsyncResult.isSuccess(found) || !found.value) {
      setPhase({
        type: "failed",
        message:
          kind === "recentPhoto"
            ? "No photo from the last 15 minutes."
            : "The phone knows no location yet.",
      });
      return;
    }
    setAskedFor((current) => ({ ...current, [kind]: true }));
  };
  const pickPhotos = async (camera: boolean) => {
    setView({ type: "compose" });
    const endHandoff = beginForegroundHandoff();
    const picked = await settlePromise(async () => {
      const picker = camera ? withCameraLauncher(ImagePicker) : ImagePicker;
      return picker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        base64: false,
        quality: 1,
      });
    });
    endHandoff();
    if (AsyncResult.isFailure(picked)) return fail(picked, "The photos could not be opened.");
    if (picked.value.canceled) return;
    setAddedPhotos((current) => [
      ...current,
      ...(picked.value.assets ?? []).map((asset) => ({ id: `photo:${uuidv4()}`, uri: asset.uri })),
    ]);
  };
  const pickFiles = async () => {
    setView({ type: "compose" });
    const picked = await settlePromise(() =>
      pickComposerFiles({ existingCount: addedFiles.length, maxBytes: maxUploadBytes }),
    );
    if (AsyncResult.isFailure(picked)) return fail(picked, "The files could not be opened.");
    setAddedFiles((current) => [...current, ...picked.value.files]);
    if (picked.value.error) setPhase({ type: "failed", message: picked.value.error });
  };
  const addItems: ReadonlyArray<PanelMenuItem> = [
    { key: "photos", icon: "photo", label: "Photos", onPress: () => void pickPhotos(false) },
    { key: "camera", icon: "camera", label: "Take a photo", onPress: () => void pickPhotos(true) },
    ...(maxUploadBytes === undefined
      ? []
      : [
          {
            key: "file",
            icon: "paperclip",
            label: "File",
            onPress: () => void pickFiles(),
          } as const,
        ]),
    ...(originalContext.recentPhoto === null
      ? [
          {
            key: "recentPhoto",
            icon: "photo",
            label: "Most recent photo",
            onPress: () => void askForPill("recentPhoto"),
          } as const,
        ]
      : []),
    ...(originalContext.location === null
      ? [
          {
            key: "location",
            icon: "mappin",
            label: "Location",
            onPress: () => void askForPill("location"),
          } as const,
        ]
      : []),
  ];

  // Above the keyboard the system inset is gone, so the row sits right on its edge.
  const bottomPadding = keyboardVisible ? 8 : insets.bottom + 12;
  const typed = text.trim().length > 0;
  const targetLabel = targetThread
    ? targetThread.title.trim() || "Untitled thread"
    : conversationRef
      ? "Starting the thread…"
      : project
        ? `New thread · ${project.title}`
        : pickedEnvironmentId !== null && machineProjects.length === 0
          ? "No projects on this machine"
          : "Loading projects…";
  const status = (() => {
    if (afterDelivery === "wait") return "Waiting for the reply…";
    if (afterDelivery === "read") return "Reading the reply aloud";
    if (phase.type === "sending" && !delivered) {
      return connected ? "Sending…" : "Queued. It sends when the server connects.";
    }
    return connected ? "Connected" : "Not connected. The message waits in the outbox.";
  })();
  const pillView = view.type === "pill" ? view.id : null;
  const openedPhoto = addedPhotos.find((photo) => photo.id === pillView);
  const openedFile = addedFiles.find((file) => file.id === pillView);
  const removeAdded = (id: string) => {
    setAddedPhotos((current) => current.filter((photo) => photo.id !== id));
    setAddedFiles((current) => current.filter((file) => file.id !== id));
    resetImage(id);
    setView({ type: "compose" });
  };

  return (
    <View className="flex-1 justify-end">
      {/* No dim layer: the edge glow marks the panel, and the app under it stays readable. */}
      <Pressable
        accessibilityLabel={view.type === "compose" ? "Close" : "Back to the message"}
        className="absolute inset-0"
        onPress={back}
      />
      <KeyboardAvoidingView behavior="padding">
        <View
          className="gap-3 rounded-t-3xl bg-sheet px-4 pt-1"
          style={{ paddingBottom: bottomPadding }}
        >
          <OpenInAppHandle
            label={targetThread ? "Open the thread in the app" : "Continue in the app"}
            disabled={busy || conversationPending || (targetThread === null && draftKey === null)}
            onOpen={() => void openInApp()}
          />
          <View className="flex-row items-center justify-between gap-2">
            {machines.length > 1 && targetMachine && conversationRef === null ? (
              <MachineButton
                machine={targetMachine}
                expanded={view.type === "machine"}
                disabled={busy}
                onPress={() =>
                  setView((current) =>
                    current.type === "machine" ? { type: "compose" } : { type: "machine" },
                  )
                }
              />
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${targetLabel}. Change where to send`}
              accessibilityState={{
                expanded: view.type === "target",
                disabled: busy || conversationRef !== null,
              }}
              className="flex-1"
              // The conversation stays in its thread; the arrow above opens it in the app.
              disabled={busy || conversationRef !== null}
              onPress={() =>
                setView((current) =>
                  current.type === "target" ? { type: "compose" } : { type: "target" },
                )
              }
            >
              <View className="flex-row items-center gap-1">
                <Text textRole="body" className="shrink font-medium" numberOfLines={1}>
                  {targetLabel}
                </Text>
                {conversationRef === null ? (
                  <SymbolView
                    name={view.type === "target" ? "chevron.up" : "chevron.down"}
                    size={14}
                    tintColorClassName="accent-foreground-muted"
                  />
                ) : null}
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
              accessibilityLabel={view.type === "compose" ? "Close" : "Back to the message"}
              icon="xmark"
              onPress={back}
            />
          </View>

          {view.type === "machine" ? (
            <MachineList
              machines={machines}
              selected={targetEnvironmentId}
              onPick={(environmentId) => {
                setPickedEnvironmentId(environmentId);
                // A target on another machine no longer fits; the machine's default takes over.
                if (environmentId !== targetEnvironmentId) setPickedTarget(null);
                setView({ type: "compose" });
              }}
            />
          ) : view.type === "target" ? (
            <AssistantTargetPicker
              target={target}
              threads={machineThreads}
              projects={machineProjects}
              environmentLabel={environmentLabel}
              onPick={(picked) => {
                setPickedTarget(picked);
                setView({ type: "compose" });
              }}
            />
          ) : view.type === "add" ? (
            <PanelMenu items={addItems} />
          ) : openedPhoto ? (
            <ImageContextEditor
              key={openedPhoto.id}
              title="Photo"
              uri={editedImages[openedPhoto.id] ?? openedPhoto.uri}
              imageWidth={0}
              imageHeight={0}
              edited={editedImages[openedPhoto.id] !== undefined}
              onSave={(strokes, crop) =>
                void editImage(
                  openedPhoto.id,
                  editedImages[openedPhoto.id] ?? openedPhoto.uri,
                  strokes,
                  crop,
                )
              }
              onReset={() => resetImage(openedPhoto.id)}
              onRemove={() => removeAdded(openedPhoto.id)}
              onDone={() => setView({ type: "compose" })}
            />
          ) : openedFile ? (
            <FileContextView
              name={openedFile.name}
              sizeBytes={openedFile.sizeBytes}
              onRemove={() => removeAdded(openedFile.id)}
              onDone={() => setView({ type: "compose" })}
            />
          ) : pillView !== null &&
            isFoundPill(pillView) &&
            (pillView === "sharedImage" ||
              pillView === "screenshot" ||
              pillView === "recentPhoto") ? (
            <ImageContextEditor
              key={pillView}
              title={CONTEXT_PILL_TITLES[pillView]}
              uri={foundImageUri(pillView) ?? ""}
              // Only the screenshot arrives with its size, and an edit can change the size.
              imageWidth={
                pillView === "screenshot" && editedImages[pillView] === undefined
                  ? (capture?.screenshotWidth ?? 0)
                  : 0
              }
              imageHeight={
                pillView === "screenshot" && editedImages[pillView] === undefined
                  ? (capture?.screenshotHeight ?? 0)
                  : 0
              }
              edited={editedImages[pillView] !== undefined}
              onSave={(strokes, crop) => {
                const base = foundImageUri(pillView);
                if (base) void editImage(pillView, base, strokes, crop);
              }}
              onReset={() => resetImage(pillView)}
              onDone={() => setView({ type: "compose" })}
            />
          ) : pillView !== null && isFoundPill(pillView) && !isImageContextPill(pillView) ? (
            <TextContextEditor
              title={CONTEXT_PILL_TITLES[pillView]}
              subtitle={pillView === "screenText" ? (capture?.sourcePackage ?? null) : null}
              value={contextValue(pillView)}
              edited={editedText[pillView] !== undefined}
              onChange={(value) => setEditedText((current) => ({ ...current, [pillView]: value }))}
              onReset={() =>
                setEditedText((current) => {
                  const next = { ...current };
                  delete next[pillView];
                  return next;
                })
              }
              onDone={() => setView({ type: "compose" })}
            />
          ) : (
            <>
              {conversationRef ? (
                <AssistantConversation threadRef={conversationRef} sent={sent} />
              ) : null}
              <ContextPills
                pills={pills}
                disabled={busy}
                onAdd={() => setView({ type: "add" })}
                onToggle={(id) => void togglePill(id)}
                onOpen={(id) => void openPill(id)}
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
                    placeholder={
                      conversationRef
                        ? "Reply"
                        : targetThread
                          ? "Message"
                          : "What should the agent do?"
                    }
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
      {voice.assistantGlowSeconds === 0 ? null : <EdgeGlow seconds={voice.assistantGlowSeconds} />}
    </View>
  );
}
