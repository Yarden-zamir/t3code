import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import {
  Image,
  PanResponder,
  Pressable,
  ScrollView,
  View,
  type GestureResponderEvent,
} from "react-native";
import Svg, { Path } from "react-native-svg";

import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import type { AnnotationStroke } from "../../native/assistant";
import type { ContextPillKind } from "./contextPills";

/** Fork: the parts of the Android assistant panel that are not the composer row. */

export interface ContextPillView {
  readonly kind: ContextPillKind;
  readonly label: string;
  readonly attached: boolean;
  /** The screenshot pill shows the image itself. */
  readonly thumbnailUri: string | null;
}

/** A tap attaches or leaves out a pill; a hold opens it. A pill that is left out is grayed out. */
export function ContextPills(props: {
  readonly pills: ReadonlyArray<ContextPillView>;
  readonly onToggle: (kind: ContextPillKind) => void;
  readonly onOpen: (kind: ContextPillKind) => void;
}) {
  if (props.pills.length === 0) return null;
  // One row that scrolls, so the pills never push the text field up.
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2"
    >
      {props.pills.map((pill) => (
        <Pressable
          key={pill.kind}
          accessibilityRole="switch"
          accessibilityLabel={pill.label}
          accessibilityHint="Hold to read and edit"
          accessibilityState={{ checked: pill.attached }}
          className={cn(
            "h-8 flex-row items-center gap-1.5 rounded-full border border-input-border px-2.5",
            pill.attached ? "bg-input" : "opacity-45",
          )}
          delayLongPress={350}
          onPress={() => props.onToggle(pill.kind)}
          onLongPress={() => props.onOpen(pill.kind)}
        >
          {pill.thumbnailUri ? (
            <Image source={{ uri: pill.thumbnailUri }} className="h-6 w-4 rounded-sm" />
          ) : (
            <SymbolView
              name={CONTEXT_PILL_ICONS[pill.kind]}
              size={14}
              tintColorClassName="accent-foreground-muted"
            />
          )}
          <Text className="max-w-48 text-xs" numberOfLines={1}>
            {pill.label}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const CONTEXT_PILL_ICONS = {
  screenshot: "photo",
  screenText: "doc.text",
  selection: "text.alignleft",
  link: "link",
  clipboard: "doc.on.doc",
  sharedText: "text.alignleft",
  sharedImage: "photo",
  recentPhoto: "photo",
  location: "mappin",
} as const satisfies Record<ContextPillKind, AppSymbolName>;

function EditorHeader(props: {
  readonly title: string;
  readonly subtitle: string | null;
  readonly children?: React.ReactNode;
}) {
  return (
    <View className="flex-row items-center gap-2">
      <View className="flex-1">
        <Text className="text-sm font-medium">{props.title}</Text>
        {props.subtitle ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.children}
    </View>
  );
}

function TextButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      hitSlop={6}
      className={cn("rounded-lg px-2 py-1.5", props.disabled ? "opacity-40" : "")}
      onPress={props.onPress}
    >
      <Text className="text-sm font-medium text-primary-text">{props.label}</Text>
    </Pressable>
  );
}

/** Reads and edits a text pill. Notes typed into the text go to the agent with it. */
export function TextContextEditor(props: {
  readonly title: string;
  readonly subtitle: string | null;
  readonly value: string;
  readonly edited: boolean;
  readonly onChange: (value: string) => void;
  readonly onReset: () => void;
  readonly onDone: () => void;
}) {
  return (
    <View className="gap-2">
      <EditorHeader title={props.title} subtitle={props.subtitle}>
        <TextButton label="Reset" disabled={!props.edited} onPress={props.onReset} />
        <TextButton label="Done" onPress={props.onDone} />
      </EditorHeader>
      <AppTextInput
        multiline
        className="max-h-80 min-h-32 text-sm"
        textAlignVertical="top"
        value={props.value}
        onChangeText={props.onChange}
      />
    </View>
  );
}

const STROKE_COLOR = "#FF3B30";
/** A fraction of the image width, so the line keeps its weight on any screen size. */
const STROKE_WIDTH = 0.006;
const EDITOR_MAX_HEIGHT = 380;

function strokePath(points: ReadonlyArray<number>): string {
  let path = "";
  for (let index = 0; index + 1 < points.length; index += 2) {
    path += `${index === 0 ? "M" : " L"}${points[index] ?? 0} ${points[index + 1] ?? 0}`;
  }
  return path;
}

/** Draws on an image pill. Done paints the strokes onto a copy of the image. */
export function ImageContextEditor(props: {
  readonly title: string;
  readonly uri: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly annotated: boolean;
  readonly onSave: (strokes: ReadonlyArray<AnnotationStroke>) => void;
  readonly onReset: () => void;
  readonly onDone: () => void;
}) {
  // Points are in view pixels while drawing; Done turns them into fractions of the image.
  const [strokes, setStrokes] = useState<ReadonlyArray<ReadonlyArray<number>>>([]);
  const [current, setCurrent] = useState<ReadonlyArray<number> | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [measured, setMeasured] = useState<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  const knownSize = props.imageWidth > 0 && props.imageHeight > 0;
  const uri = props.uri;
  // Only the screenshot arrives with its size; a photo is measured once.
  useEffect(() => {
    if (knownSize) return;
    let cancelled = false;
    Image.getSize(
      uri,
      (width, height) => {
        if (!cancelled) setMeasured({ width, height });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [knownSize, uri]);
  const size = knownSize
    ? { width: props.imageWidth, height: props.imageHeight }
    : (measured ?? { width: 9, height: 20 });
  const aspect = size.width / size.height;
  const width = Math.min(availableWidth, EDITOR_MAX_HEIGHT * aspect);
  const height = width / aspect;
  const [responder] = useState(() => {
    const point = (event: GestureResponderEvent) =>
      [event.nativeEvent.locationX, event.nativeEvent.locationY] as const;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => setCurrent([...point(event)]),
      onPanResponderMove: (event) =>
        setCurrent((points) => (points ? [...points, ...point(event)] : [...point(event)])),
      onPanResponderRelease: () =>
        setCurrent((points) => {
          if (points && points.length >= 4) setStrokes((done) => [...done, points]);
          return null;
        }),
    });
  });
  const save = () => {
    if (strokes.length === 0 || width === 0) return props.onDone();
    props.onSave(
      strokes.map((points) => ({
        points: points.map((value, index) =>
          Math.min(Math.max(value / (index % 2 === 0 ? width : height), 0), 1),
        ),
        width: STROKE_WIDTH,
        color: STROKE_COLOR,
      })),
    );
  };
  const drawn = current ? [...strokes, current] : strokes;

  return (
    <View className="gap-2">
      <EditorHeader
        title={props.title}
        subtitle={props.annotated ? "Marked up. Draw to add more." : "Draw to mark it up."}
      >
        <TextButton
          label="Undo"
          disabled={strokes.length === 0}
          onPress={() => setStrokes((done) => done.slice(0, -1))}
        />
        <TextButton
          label="Reset"
          disabled={!props.annotated && strokes.length === 0}
          onPress={() => {
            setStrokes([]);
            props.onReset();
          }}
        />
        <TextButton label="Done" onPress={save} />
      </EditorHeader>
      <View
        className="items-center"
        onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
      >
        {width > 0 ? (
          <View style={{ width, height }} {...responder.panHandlers}>
            <Image
              source={{ uri: props.uri }}
              className="absolute inset-0 rounded-lg"
              resizeMode="stretch"
            />
            <Svg width={width} height={height} className="absolute inset-0">
              {drawn.map((points) => (
                <Path
                  key={points.slice(0, 2).join(",") + `:${points.length}`}
                  d={strokePath(points)}
                  stroke={STROKE_COLOR}
                  strokeWidth={STROKE_WIDTH * width}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              ))}
            </Svg>
          </View>
        ) : null}
      </View>
    </View>
  );
}

export interface PanelMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly kind: EnvironmentMachineKind;
  readonly connected: boolean;
}

/** The machine icon of the target. It names the machine only in the list it opens. */
export function MachineButton(props: {
  readonly machine: PanelMachine;
  readonly expanded: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Machine: ${props.machine.label}. Change machine`}
      accessibilityState={{ expanded: props.expanded, disabled: props.disabled }}
      disabled={props.disabled}
      hitSlop={8}
      className="h-9 w-9 items-center justify-center rounded-full bg-input"
      onPress={props.onPress}
    >
      <EnvironmentMachineSymbol
        kind={props.machine.kind}
        size={18}
        tintColorClassName={props.expanded ? "accent-primary" : "accent-foreground"}
      />
    </Pressable>
  );
}

export function MachineList(props: {
  readonly machines: ReadonlyArray<PanelMachine>;
  readonly selected: EnvironmentId | undefined;
  readonly onPick: (environmentId: EnvironmentId) => void;
}) {
  return (
    <View>
      {props.machines.map((machine) => (
        <Pressable
          key={machine.environmentId}
          accessibilityRole="button"
          accessibilityState={{ selected: machine.environmentId === props.selected }}
          className="flex-row items-center gap-3 rounded-xl px-1 py-2.5"
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          onPress={() => props.onPick(machine.environmentId)}
        >
          <EnvironmentMachineSymbol
            kind={machine.kind}
            size={18}
            tintColorClassName="accent-foreground-muted"
          />
          <View className="flex-1">
            <Text className="text-base" numberOfLines={1}>
              {machine.label}
            </Text>
            {machine.connected ? null : (
              <Text className="text-xs text-foreground-muted">Not connected</Text>
            )}
          </View>
          {machine.environmentId === props.selected ? (
            <SymbolView name="checkmark" size={16} tintColorClassName="accent-primary" />
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}
