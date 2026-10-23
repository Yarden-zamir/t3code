/**
 * Fork: the editor of one sidebar tab, like the tab editor of web (SidebarTabBar.tsx):
 * its name, icon and rules, or the name, icon and threads of the first tab. Each change saves at
 * once through `editSidebarTabs`.
 */
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  buildSidebarTabProjectFacts,
  buildSidebarTabRuleOptions,
  DEFAULT_SIDEBAR_TAB_ID,
  DEFAULT_SIDEBAR_TAB_NAME,
  deleteSidebarTab,
  isAnyTabRule,
  SIDEBAR_TAB_RULE_FIELDS,
  sidebarTabRuleFieldLabel,
  toggleSidebarTabRuleValue,
  updateSidebarDefaultTab,
  updateSidebarTab,
} from "@t3tools/client-runtime/state/sidebarTabs";
import {
  isKnownSidebarTabRule,
  type SidebarTab,
  type SidebarTabRule,
  type SidebarTabRuleField,
  type SidebarTabs,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useResolveClassNames } from "uniwind";

import { AppText } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { cn } from "../../lib/cn";
import { useProjects, useThreadShells } from "../../state/entities";
import {
  createMobileSidebarTab,
  editedSidebarTabIdAtom,
  editSidebarTabs,
  openSidebarTabEditor,
  sidebarTabsAtom,
} from "../../state/forkSidebarTabs";
import { TAB_ICON_IDS, SidebarTabIcon } from "../home/forkTabIcons";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

type ValueField = Exclude<SidebarTabRuleField, "title">;
const VALUE_FIELDS = SIDEBAR_TAB_RULE_FIELDS.filter(
  (field): field is ValueField => field !== "title",
);

export function SettingsSidebarTabRouteScreen() {
  const insets = useSafeAreaInsets();
  const settings = useAtomValue(sidebarTabsAtom);
  const tabId = useAtomValue(editedSidebarTabIdAtom);
  const tab = settings?.tabs.find((candidate) => candidate.id === tabId);
  const isDefault = tabId === DEFAULT_SIDEBAR_TAB_ID;
  return (
    <SettingsScreen title={isDefault ? "First tab" : (tab?.name ?? "Tab")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        keyboardShouldPersistTaps="handled"
      >
        {settings === null || (!isDefault && tab === undefined) ? (
          <AppText className="px-2 text-base text-foreground-muted">
            This tab no longer exists, or no connected environment has sidebar tabs on.
          </AppText>
        ) : isDefault ? (
          <DefaultTabEditor settings={settings} />
        ) : (
          <TabEditor settings={settings} tab={tab!} />
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function DefaultTabEditor(props: { readonly settings: SidebarTabs }) {
  const { defaultTab } = props.settings;
  const setDefaultTab = (change: (tab: SidebarTabs["defaultTab"]) => SidebarTabs["defaultTab"]) =>
    editSidebarTabs((current) => updateSidebarDefaultTab(current, change));
  return (
    <>
      <NameField
        name={defaultTab.name ?? ""}
        placeholder={DEFAULT_SIDEBAR_TAB_NAME}
        onCommit={(name) =>
          setDefaultTab(({ name: _name, ...rest }) =>
            name.length === 0 ? rest : { ...rest, name },
          )
        }
      />
      <LookEditor
        look={defaultTab}
        onChange={(look) => setDefaultTab((tab) => ({ ...tab, ...look }))}
      />
      <SettingsSection title="This tab shows">
        <ListChoiceRow
          label="Threads in no other tab"
          selected={defaultTab.show !== "all"}
          onPress={() => setDefaultTab((tab) => ({ ...tab, show: "untabbed" }))}
        />
        <ListChoiceRow
          label="All threads"
          separated
          selected={defaultTab.show === "all"}
          onPress={() => setDefaultTab((tab) => ({ ...tab, show: "all" }))}
        />
      </SettingsSection>
    </>
  );
}

function TabEditor(props: { readonly settings: SidebarTabs; readonly tab: SidebarTab }) {
  const { settings, tab } = props;
  const navigation = useNavigation();
  const update = (change: (tab: SidebarTab) => SidebarTab) =>
    editSidebarTabs((current) => updateSidebarTab(current, tab.id, change));
  const setRules = (rules: SidebarTab["rules"]) => update((current) => ({ ...current, rules }));
  const knownRules = tab.rules.filter(isKnownSidebarTabRule);
  const isView = knownRules.some((rule) => rule.field === "tab");
  const unknownCount = tab.rules.length - knownRules.length;

  // Options come from every live thread, once per change of the threads or the projects.
  const threads = useThreadShells();
  const projects = useProjects();
  const facts = useMemo(() => buildSidebarTabProjectFacts(projects), [projects]);
  const liveThreads = useMemo(
    () => threads.filter((thread) => thread.archivedAt === null),
    [threads],
  );
  const [titleText, setTitleText] = useState("");
  const titleRule = knownRules.find((rule) => rule.field === "title");

  return (
    <>
      <NameField
        name={tab.name}
        placeholder="Tab name"
        onCommit={(name) => {
          if (name.length > 0) update((current) => ({ ...current, name }));
        }}
      />
      <LookEditor look={tab} onChange={(look) => update((current) => ({ ...current, ...look }))} />
      <SettingsSection
        title="Rules"
        footer={
          (knownRules.length === 0
            ? "No rules. The tab holds the threads that you move into it."
            : isView
              ? "A view: it shows the threads of other tabs that match every rule."
              : "Holds every thread that matches every rule, and the threads that you move into it.") +
          (unknownCount > 0
            ? ` ${unknownCount} rule${unknownCount === 1 ? "" : "s"} from a newer version stay as they are.`
            : "")
        }
      >
        {VALUE_FIELDS.map((field, index) => (
          <RuleFieldEditor
            key={field}
            field={field}
            separated={index > 0}
            rule={knownRules.find((rule) => rule.field === field) ?? null}
            options={() =>
              buildSidebarTabRuleOptions({
                field,
                tabId: tab.id,
                threads: liveThreads,
                projects: facts,
                settings,
              })
            }
            onToggle={(value, checked) =>
              setRules(toggleSidebarTabRuleValue(tab.rules, field, value, checked))
            }
            onSetRule={(next) =>
              setRules(
                next === null
                  ? tab.rules.filter(
                      (rule) => !(isKnownSidebarTabRule(rule) && rule.field === field),
                    )
                  : tab.rules.some((rule) => isKnownSidebarTabRule(rule) && rule.field === field)
                    ? tab.rules.map((rule) =>
                        isKnownSidebarTabRule(rule) && rule.field === field ? next : rule,
                      )
                    : [...tab.rules, next],
              )
            }
          />
        ))}
      </SettingsSection>
      <SettingsSection title="Title contains">
        {(titleRule?.values ?? []).map((value) => (
          <ListActionRow
            key={value ?? ""}
            label={value ?? ""}
            detail="Remove"
            onPress={() => setRules(toggleSidebarTabRuleValue(tab.rules, "title", value, false))}
          />
        ))}
        <View className="px-4 py-3">
          <TextInput
            accessibilityLabel="Add a title rule"
            value={titleText}
            onChangeText={setTitleText}
            returnKeyType="done"
            onSubmitEditing={() => {
              const text = titleText.trim();
              if (text.length === 0) return;
              setRules(toggleSidebarTabRuleValue(tab.rules, "title", text, true));
              setTitleText("");
            }}
            placeholder="Add text, then press Done"
            placeholderTextColorClassName="accent-foreground-muted"
            className="min-h-8 font-sans text-base text-foreground"
          />
        </View>
      </SettingsSection>
      <SettingsSection>
        <ListActionRow
          label="Delete tab"
          tone="danger"
          onPress={() =>
            Dialog.confirm({
              title: `Delete ${tab.name}?`,
              message: "Its threads go back to the rules or to the first tab.",
              confirmText: "Delete",
              destructive: true,
              onConfirm: () => {
                editSidebarTabs((current) => deleteSidebarTab(current, tab.id));
                navigation.goBack();
              },
            })
          }
        />
      </SettingsSection>
    </>
  );
}

/** One rule field: closed, it names the picked values; open, it lists every value to check. */
function RuleFieldEditor(props: {
  readonly field: ValueField;
  readonly separated: boolean;
  readonly rule: SidebarTabRule | null;
  readonly options: () => ReturnType<typeof buildSidebarTabRuleOptions>;
  readonly onToggle: (value: string | null, checked: boolean) => void;
  readonly onSetRule: (rule: SidebarTabRule | null) => void;
}) {
  const { field, rule } = props;
  const [open, setOpen] = useState(false);
  // Built only while open, so a closed field costs nothing.
  const options = open ? props.options() : [];
  const anyTab = rule !== null && isAnyTabRule(rule);
  const summary =
    rule === null
      ? "Any"
      : anyTab
        ? "Any tab"
        : `${rule.operator === "is" ? "Is" : "Is not"} ${rule.values.length} value${rule.values.length === 1 ? "" : "s"}`;
  return (
    <View className={cn(props.separated && "border-t border-border-subtle")}>
      <ListActionRow
        label={sidebarTabRuleFieldLabel(field)}
        detail={summary}
        onPress={() => setOpen((current) => !current)}
      />
      {open ? (
        <View className="pb-2">
          {rule !== null && !anyTab ? (
            <View className="px-4 pb-2">
              <SegmentedControl
                size="compact"
                options={[
                  { value: "is", label: "Is" },
                  { value: "is_not", label: "Is not" },
                ]}
                selected={rule.operator}
                onSelect={(operator) => props.onSetRule({ ...rule, operator })}
              />
            </View>
          ) : null}
          {field === "tab" ? (
            <ListToggleRow
              label="Any tab (shows every thread)"
              value={anyTab}
              onValueChange={(checked) =>
                props.onSetRule(checked ? { field: "tab", operator: "is_not", values: [] } : null)
              }
            />
          ) : null}
          {options.map((option) => (
            <ListToggleRow
              key={option.value ?? ""}
              label={option.label}
              value={!anyTab && rule !== null && rule.values.includes(option.value)}
              onValueChange={(checked) => props.onToggle(option.value, checked)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The name field. It saves when the keyboard closes, not at each key. */
function NameField(props: {
  readonly name: string;
  readonly placeholder: string;
  readonly onCommit: (name: string) => void;
}) {
  const [name, setName] = useState(props.name);
  const commit = () => {
    const trimmed = name.trim();
    if (trimmed !== props.name) props.onCommit(trimmed);
  };
  return (
    <SettingsSection title="Name">
      <View className="px-4 py-3">
        <TextInput
          accessibilityLabel="Name"
          value={name}
          onChangeText={setName}
          onBlur={commit}
          onSubmitEditing={commit}
          returnKeyType="done"
          placeholder={props.placeholder}
          placeholderTextColorClassName="accent-foreground-muted"
          className="min-h-8 font-sans text-base text-foreground"
        />
      </View>
    </SettingsSection>
  );
}

type TabLook = { readonly icon?: string; readonly showName?: boolean };

/** The icon and the name of a tab. `none` hides the icon; without a choice the tab shows a dot. */
function LookEditor(props: {
  readonly look: { readonly icon?: string | undefined; readonly showName?: boolean | undefined };
  readonly onChange: (look: TabLook) => void;
}) {
  const current = props.look.icon ?? "dot";
  const { color: selectedColor } = useResolveClassNames("text-foreground");
  const { color: mutedColor } = useResolveClassNames("text-foreground-muted");
  return (
    <SettingsSection title="Tab">
      <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-1 px-3 py-3">
        {[...TAB_ICON_IDS, "none"].map((id) => (
          <Pressable
            key={id}
            accessibilityRole="radio"
            accessibilityLabel={id === "none" ? "No icon" : id}
            accessibilityState={{ checked: current === id }}
            onPress={() => props.onChange({ icon: id })}
            className={cn(
              "size-10 items-center justify-center rounded-lg active:opacity-70",
              current === id && "bg-subtle",
            )}
          >
            {id === "none" ? (
              <SymbolView name="xmark" size={18} tintColorClassName="accent-foreground-muted" />
            ) : (
              <SidebarTabIcon
                icon={id}
                size={20}
                color={current === id ? selectedColor : mutedColor}
              />
            )}
          </Pressable>
        ))}
      </View>
      <ListToggleRow
        label="Show the name on the tab"
        value={props.look.showName !== false}
        onValueChange={(showName) => props.onChange({ showName })}
      />
    </SettingsSection>
  );
}

/** The tabs in the Fork settings page: each one opens its editor, and the last row makes one. */
export function SidebarTabSettingsSection() {
  const settings = useAtomValue(sidebarTabsAtom);
  const navigation = useNavigation();
  if (settings === null) return null;
  return (
    <SettingsSection
      title="Sidebar tabs"
      footer="Long-press a tab or a thread on the thread list for the same changes."
    >
      <ListActionRow
        label={settings.defaultTab.name ?? DEFAULT_SIDEBAR_TAB_NAME}
        detail="First tab"
        onPress={() => openSidebarTabEditor(navigation, DEFAULT_SIDEBAR_TAB_ID)}
      />
      {settings.tabs.map((tab) => (
        <ListActionRow
          key={tab.id}
          label={tab.name}
          onPress={() => openSidebarTabEditor(navigation, tab.id)}
        />
      ))}
      <ListActionRow
        icon="plus"
        label="New tab"
        onPress={() => openSidebarTabEditor(navigation, createMobileSidebarTab())}
      />
    </SettingsSection>
  );
}
