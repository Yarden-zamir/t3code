import {
  AuthSettingsWriteScope,
  type MobileNewThreadProject,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { type ComponentProps, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
} from "./settings-scoped-server";

/**
 * Fork: the fork server settings of the mobile app. The Fork screen shows all of them. A row
 * with a `place` also shows on that upstream screen. Each write goes to every environment that
 * the filter selects, for the whole environment, so upstream screens hide the fork sections while
 * a project is selected.
 */
export function useForkMobileSettings() {
  const { selectedTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  const writableEnvironments = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const targets = resolveMobileSettingsTargets(selectedTargets, null);
  const [pendingWrites, setPendingWrites] = useState(0);
  const writeInFlight = useRef(false);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "fork settings update",
    reportFailure: true,
  });
  const disabled =
    targets.length === 0 ||
    pendingWrites > 0 ||
    !targets.every((target) => writableEnvironments.has(target.environment.environmentId));

  const write = (patch: ServerSettingsPatch) => {
    if (
      writeInFlight.current ||
      !targets.every((target) =>
        readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    const writes = planMobileScopedSettingsPatch(targets, false, patch);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingWrites((count) => count + 1);
    void Promise.allSettled(
      writes.map((entry) =>
        updateSettings({ environmentId: entry.environmentId, input: { patch: entry.patch } }),
      ),
    ).finally(() => {
      writeInFlight.current = false;
      setPendingWrites((count) => count - 1);
    });
  };

  return { targets, disabled, write, projectSelected: selectedProjectKey !== null };
}

const FORK_MOBILE_SWITCHES = [
  {
    key: "mobilePublishedThemes",
    icon: "paintbrush",
    label: "Published themes",
    subtitle:
      "Offer the themes of your servers in Appearance, with their fonts, shape and canvas pattern, and take the default theme of the server.",
  },
  {
    key: "mobileComposerCamera",
    icon: "camera",
    label: "Camera in the composer",
    subtitle: "The plus button of the composer offers Take Photo.",
    place: "threads",
  },
  {
    key: "mobileMessagePins",
    icon: "pin",
    label: "Message pins",
    subtitle: "A long press on a message offers Pin and Unpin.",
    place: "threads",
  },
  {
    key: "mobileSidebarTabs",
    icon: "square.grid.2x2",
    label: "Sidebar tabs",
    subtitle: "The thread list shows the tabs of the web sidebar. Tap a tab to show its threads.",
  },
  {
    key: "mobileWarmRecentChats",
    icon: "arrow.down.circle",
    label: "Warm recent chats",
    subtitle:
      "After the thread list syncs, load the newest threads into the message cache, so they open without a wait.",
  },
  {
    key: "threadLinkChips",
    icon: "link",
    label: "Thread link chips",
    subtitle: "Thread links in chat look like an attached thread and open the thread here.",
    place: "threads",
  },
  {
    key: "messageLinks",
    icon: "text.bubble",
    label: "Message links",
    subtitle:
      "Holding the copy button of a message copies a link to it. A link that names a message always opens it.",
    place: "threads",
  },
] as const satisfies ReadonlyArray<{
  readonly key: keyof ServerSettingsPatch;
  readonly icon: ComponentProps<typeof SettingsSwitchRow>["icon"];
  readonly label: string;
  readonly subtitle: string;
  readonly place?: "threads";
}>;

type ForkMobileSettings = ReturnType<typeof useForkMobileSettings>;

/** The fork switches; `place` limits them to the ones of that screen. */
export function ForkMobileSwitchRows(props: {
  readonly settings: ForkMobileSettings;
  readonly place?: "threads";
}) {
  const { targets, disabled, write } = props.settings;
  return FORK_MOBILE_SWITCHES.filter(
    (row) => props.place === undefined || ("place" in row && row.place === props.place),
  ).map((row) => (
    <SettingsSwitchRow
      key={row.key}
      icon={row.icon}
      label={row.label}
      subtitle={row.subtitle}
      value={uniformMobileSetting(targets, row.key)}
      disabled={disabled}
      onValueChange={(value) => write({ [row.key]: value })}
    />
  ));
}

/** Threads: the fork switches about chat. */
export function ForkMobileThreadsSection() {
  const settings = useForkMobileSettings();
  if (settings.targets.length === 0 || settings.projectSelected) return null;
  return (
    <SettingsSection title="Chat">
      <ForkMobileSwitchRows settings={settings} place="threads" />
    </SettingsSection>
  );
}

const NEW_THREAD_CHOICES: ReadonlyArray<{
  readonly mode: MobileNewThreadProject;
  readonly label: string;
  readonly description: string;
}> = [
  { mode: "picker", label: "Choose a project", description: "Show the project list first." },
  {
    mode: "last",
    label: "Last project",
    description: "Open a draft in the project of the last new thread on this phone.",
  },
  { mode: "none", label: "No project", description: "Open a draft without a project." },
];

/** `mobileNewThreadProject`, on the Fork screen. */
export function ForkMobileNewThreadSection(props: { readonly settings: ForkMobileSettings }) {
  const { targets, disabled, write } = props.settings;
  const newThreadProject = uniformMobileSetting(targets, "mobileNewThreadProject");
  return (
    <SettingsSection title="New thread opens">
      {NEW_THREAD_CHOICES.map((choice, index) => (
        <SettingsChoiceRow
          key={choice.mode}
          label={choice.label}
          description={choice.description}
          selected={newThreadProject === choice.mode}
          separated={index > 0}
          disabled={disabled}
          onPress={() => write({ mobileNewThreadProject: choice.mode })}
        />
      ))}
    </SettingsSection>
  );
}

/** Server settings > New threads: what New thread opens. */
export function ForkMobileNewThreadsServerSection() {
  const settings = useForkMobileSettings();
  if (settings.targets.length === 0 || settings.projectSelected) return null;
  return <ForkMobileNewThreadSection settings={settings} />;
}
