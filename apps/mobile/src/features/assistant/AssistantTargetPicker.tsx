import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { projectsForPicker, recentThreadsForPicker } from "./assistantTargets";

export type AssistantTarget =
  | { readonly type: "project"; readonly project: EnvironmentProject }
  | { readonly type: "thread"; readonly thread: EnvironmentThreadShell };

/**
 * Fork: where the assistant panel sends. Mounted only while open, so the panel never builds
 * these lists for a press that keeps the default target.
 */
export function AssistantTargetPicker(props: {
  readonly target: AssistantTarget | null;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly environmentLabel: (environmentId: string) => string | null;
  readonly onPick: (target: AssistantTarget) => void;
}) {
  const [query, setQuery] = useState("");
  const recentThreads = recentThreadsForPicker(props.threads, query);
  const projects = projectsForPicker(props.projects, props.threads, query);
  const showsEnvironment = new Set(props.projects.map((project) => project.environmentId)).size > 1;
  const projectTitles = new Map(
    props.projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
  );
  const place = (environmentId: string, projectTitle: string | undefined) =>
    [projectTitle, showsEnvironment ? props.environmentLabel(environmentId) : null]
      .filter((part) => part)
      .join(" · ");
  const target = props.target;

  return (
    <View className="gap-2">
      <AppTextInput
        autoFocus
        className="min-h-11 py-2"
        placeholder="Search threads and projects"
        value={query}
        onChangeText={setQuery}
      />
      <ScrollView className="max-h-80" keyboardShouldPersistTaps="handled">
        {recentThreads.length > 0 ? <SectionLabel label="Continue a thread" /> : null}
        {recentThreads.map((thread) => (
          <TargetRow
            key={`thread:${thread.environmentId}:${thread.id}`}
            icon="text.bubble"
            title={thread.title.trim() || "Untitled thread"}
            subtitle={place(
              thread.environmentId,
              projectTitles.get(`${thread.environmentId}:${thread.projectId}`),
            )}
            selected={
              target?.type === "thread" &&
              target.thread.environmentId === thread.environmentId &&
              target.thread.id === thread.id
            }
            onPress={() => props.onPick({ type: "thread", thread })}
          />
        ))}
        {projects.length > 0 ? <SectionLabel label="New thread in" /> : null}
        {projects.map((project) => (
          <TargetRow
            key={`project:${project.environmentId}:${project.id}`}
            icon="folder"
            title={project.title}
            subtitle={showsEnvironment ? place(project.environmentId, undefined) : ""}
            selected={
              target?.type === "project" &&
              target.project.environmentId === project.environmentId &&
              target.project.id === project.id
            }
            onPress={() => props.onPick({ type: "project", project })}
          />
        ))}
        {recentThreads.length === 0 && projects.length === 0 ? (
          <Text className="px-1 py-3 text-sm text-foreground-muted">Nothing matches.</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

function SectionLabel(props: { readonly label: string }) {
  return (
    <Text className="px-1 pb-1 pt-2 text-xs font-medium text-foreground-muted">{props.label}</Text>
  );
}

function TargetRow(props: {
  readonly icon: "text.bubble" | "folder";
  readonly title: string;
  readonly subtitle: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      className="flex-row items-center gap-3 rounded-xl px-1 py-2"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      onPress={props.onPress}
    >
      <SymbolView name={props.icon} size={16} tintColorClassName="accent-foreground-muted" />
      <View className="flex-1">
        <Text className="text-base" numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.selected ? (
        <SymbolView name="checkmark" size={16} tintColorClassName="accent-primary" />
      ) : null}
    </Pressable>
  );
}
