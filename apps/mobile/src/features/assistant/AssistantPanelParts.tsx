import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import {
  Animated as CoreAnimated,
  Image,
  Pressable,
  ScrollView,
  View,
  type GestureResponderEvent,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";

import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import type { AnnotationStroke, ImageCrop } from "../../native/assistant";
import type { ContextPillKind } from "./contextPills";

/** Fork: the parts of the Android assistant panel that are not the composer row. */

export interface ContextPillView {
  /** The kind for a pill the panel found; its own id for a photo or a file from "+". */
  readonly id: string;
  readonly kind: ContextPillKind;
  readonly label: string;
  readonly attached: boolean;
  /** An image pill shows the image itself. */
  readonly thumbnailUri: string | null;
}

/**
 * The "+" pill comes first and adds context. A tap attaches or leaves out a pill; a hold opens
 * it. A pill that is left out is grayed out.
 */
export function ContextPills(props: {
  readonly pills: ReadonlyArray<ContextPillView>;
  readonly disabled: boolean;
  readonly onAdd: () => void;
  readonly onToggle: (id: string) => void;
  readonly onOpen: (id: string) => void;
}) {
  // One row that scrolls, so the pills never push the text field up.
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add context"
        disabled={props.disabled}
        className="h-8 w-8 items-center justify-center rounded-full border border-input-border bg-input"
        onPress={props.onAdd}
      >
        <SymbolView name="plus" size={16} tintColorClassName="accent-foreground" />
      </Pressable>
      {props.pills.map((pill) => (
        <Pressable
          key={pill.id}
          accessibilityRole="switch"
          accessibilityLabel={pill.label}
          accessibilityHint="Hold to read and edit"
          accessibilityState={{ checked: pill.attached }}
          className={cn(
            "h-8 flex-row items-center gap-1.5 rounded-full border border-input-border px-2.5",
            pill.attached ? "bg-input" : "opacity-45",
          )}
          delayLongPress={350}
          onPress={() => props.onToggle(pill.id)}
          onLongPress={() => props.onOpen(pill.id)}
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
  photo: "photo",
  file: "paperclip",
  location: "mappin",
} as const satisfies Record<ContextPillKind, AppSymbolName>;

export interface PanelMenuItem {
  readonly key: string;
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly onPress: () => void;
}

/** The list the "+" pill opens. */
export function PanelMenu(props: { readonly items: ReadonlyArray<PanelMenuItem> }) {
  return (
    <View>
      {props.items.map((item) => (
        <Pressable
          key={item.key}
          accessibilityRole="button"
          className="flex-row items-center gap-3 rounded-xl px-1 py-2.5"
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          onPress={item.onPress}
        >
          <SymbolView name={item.icon} size={18} tintColorClassName="accent-foreground-muted" />
          <Text className="flex-1 text-base" numberOfLines={1}>
            {item.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

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

/** A file pill holds no text to edit, so its hold shows what it is and removes it. */
export function FileContextView(props: {
  readonly name: string;
  readonly sizeBytes: number;
  readonly onRemove: () => void;
  readonly onDone: () => void;
}) {
  return (
    <EditorHeader title={props.name} subtitle={formatAttachmentSize(props.sizeBytes)}>
      <TextButton label="Remove" onPress={props.onRemove} />
      <TextButton label="Done" onPress={props.onDone} />
    </EditorHeader>
  );
}

const STROKE_COLOR = "#FF3B30";
/** A fraction of the image width, so the line keeps its weight on any screen size. */
const STROKE_WIDTH = 0.006;
const EDITOR_MAX_HEIGHT = 380;
const FULL_CROP: ImageCrop = { x: 0, y: 0, width: 1, height: 1 };
/** How close to a corner, in pixels, a touch takes that corner. */
const CROP_HANDLE_SLOP = 36;
/** The smallest crop side, in pixels of the editor. */
const CROP_MIN_SIDE = 48;
const CROP_HANDLE_SIZE = 18;

type CropGesture = "move" | "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

function isFullCrop(crop: ImageCrop): boolean {
  return crop.x <= 0.001 && crop.y <= 0.001 && crop.width >= 0.999 && crop.height >= 0.999;
}

function strokePath(points: ReadonlyArray<number>): string {
  let path = "";
  for (let index = 0; index + 1 < points.length; index += 2) {
    path += `${index === 0 ? "M" : " L"}${points[index] ?? 0} ${points[index + 1] ?? 0}`;
  }
  return path;
}

/** Which part of the crop a touch at x, y (editor pixels) grabs, or null outside of it. */
function cropGestureAt(
  crop: ImageCrop,
  size: { readonly width: number; readonly height: number },
  x: number,
  y: number,
): CropGesture | null {
  const left = crop.x * size.width;
  const top = crop.y * size.height;
  const right = left + crop.width * size.width;
  const bottom = top + crop.height * size.height;
  const near = (a: number, b: number) => Math.abs(a - b) <= CROP_HANDLE_SLOP;
  if (near(x, left) && near(y, top)) return "topLeft";
  if (near(x, right) && near(y, top)) return "topRight";
  if (near(x, left) && near(y, bottom)) return "bottomLeft";
  if (near(x, right) && near(y, bottom)) return "bottomRight";
  return x > left && x < right && y > top && y < bottom ? "move" : null;
}

/** The crop after a drag of dx, dy pixels, kept inside the image and above the minimum size. */
function draggedCrop(
  start: ImageCrop,
  gesture: CropGesture,
  size: { readonly width: number; readonly height: number },
  dx: number,
  dy: number,
): ImageCrop {
  const fx = dx / size.width;
  const fy = dy / size.height;
  const minWidth = CROP_MIN_SIDE / size.width;
  const minHeight = CROP_MIN_SIDE / size.height;
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  if (gesture === "move") {
    return {
      ...start,
      x: clamp(start.x + fx, 0, 1 - start.width),
      y: clamp(start.y + fy, 0, 1 - start.height),
    };
  }
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  const left =
    gesture === "topLeft" || gesture === "bottomLeft"
      ? clamp(start.x + fx, 0, right - minWidth)
      : start.x;
  const top =
    gesture === "topLeft" || gesture === "topRight"
      ? clamp(start.y + fy, 0, bottom - minHeight)
      : start.y;
  const newRight =
    gesture === "topRight" || gesture === "bottomRight"
      ? clamp(right + fx, left + minWidth, 1)
      : right;
  const newBottom =
    gesture === "bottomLeft" || gesture === "bottomRight"
      ? clamp(bottom + fy, top + minHeight, 1)
      : bottom;
  return { x: left, y: top, width: newRight - left, height: newBottom - top };
}

/**
 * Crops and draws on an image pill. It opens on the crop tool, since cutting a screenshot to
 * the part that matters is the common edit. Done applies both to a copy of the image.
 */
export function ImageContextEditor(props: {
  readonly title: string;
  readonly uri: string;
  /** 0 when unknown: the editor measures the image. */
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly edited: boolean;
  readonly onSave: (strokes: ReadonlyArray<AnnotationStroke>, crop: ImageCrop | null) => void;
  readonly onReset: () => void;
  /** Present for a photo from "+", which can leave the message. */
  readonly onRemove?: () => void;
  readonly onDone: () => void;
}) {
  const [tool, setTool] = useState<"crop" | "draw">("crop");
  const [crop, setCrop] = useState<ImageCrop>(FULL_CROP);
  // Points are in editor pixels while drawing; Done turns them into fractions of the image.
  const [strokes, setStrokes] = useState<ReadonlyArray<ReadonlyArray<number>>>([]);
  const [current, setCurrent] = useState<ReadonlyArray<number> | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [measured, setMeasured] = useState<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  const knownSize = props.imageWidth > 0 && props.imageHeight > 0;
  const uri = props.uri;
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
  // Plain responder props, rebuilt each render: they keep no state of their own between
  // renders, so they always see the latest tool, crop and size.
  const [cropDrag, setCropDrag] = useState<{
    readonly gesture: CropGesture;
    readonly start: ImageCrop;
    readonly pageX: number;
    readonly pageY: number;
  } | null>(null);
  const point = (event: GestureResponderEvent) =>
    [event.nativeEvent.locationX, event.nativeEvent.locationY] as const;
  const editorSize = { width, height };
  const responder = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    onResponderTerminationRequest: () => false,
    onResponderGrant: (event: GestureResponderEvent) => {
      if (tool === "draw") {
        setCurrent([...point(event)]);
        return;
      }
      const [x, y] = point(event);
      const gesture = cropGestureAt(crop, editorSize, x, y);
      setCropDrag(
        gesture
          ? { gesture, start: crop, pageX: event.nativeEvent.pageX, pageY: event.nativeEvent.pageY }
          : null,
      );
    },
    onResponderMove: (event: GestureResponderEvent) => {
      if (tool === "draw") {
        setCurrent((points) => (points ? [...points, ...point(event)] : [...point(event)]));
        return;
      }
      if (!cropDrag) return;
      setCrop(
        draggedCrop(
          cropDrag.start,
          cropDrag.gesture,
          editorSize,
          event.nativeEvent.pageX - cropDrag.pageX,
          event.nativeEvent.pageY - cropDrag.pageY,
        ),
      );
    },
    onResponderRelease: () => {
      setCropDrag(null);
      const finished = current;
      if (finished && finished.length >= 4) setStrokes((done) => [...done, finished]);
      setCurrent(null);
    },
  };
  const changed = strokes.length > 0 || !isFullCrop(crop);
  const save = () => {
    if (!changed || width === 0) return props.onDone();
    props.onSave(
      strokes.map((points) => ({
        points: points.map((value, index) =>
          Math.min(Math.max(value / (index % 2 === 0 ? width : height), 0), 1),
        ),
        width: STROKE_WIDTH,
        color: STROKE_COLOR,
      })),
      isFullCrop(crop) ? null : crop,
    );
  };
  const drawn = current ? [...strokes, current] : strokes;
  const box = {
    left: crop.x * width,
    top: crop.y * height,
    width: crop.width * width,
    height: crop.height * height,
  };

  return (
    <View className="gap-2">
      <EditorHeader
        title={props.title}
        subtitle={tool === "crop" ? "Drag the corners to crop." : "Draw to mark it up."}
      >
        {props.onRemove ? <TextButton label="Remove" onPress={props.onRemove} /> : null}
        <TextButton
          label="Reset"
          disabled={!props.edited && !changed}
          onPress={() => {
            setStrokes([]);
            setCrop(FULL_CROP);
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
          <View style={{ width, height }} {...responder}>
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
            {isFullCrop(crop) && tool === "draw" ? null : (
              <View pointerEvents="none" className="absolute inset-0">
                <View
                  className="absolute bg-black/50"
                  style={{ left: 0, top: 0, width, height: box.top }}
                />
                <View
                  className="absolute bg-black/50"
                  style={{ left: 0, top: box.top + box.height, width, bottom: 0 }}
                />
                <View
                  className="absolute bg-black/50"
                  style={{ left: 0, top: box.top, width: box.left, height: box.height }}
                />
                <View
                  className="absolute bg-black/50"
                  style={{ left: box.left + box.width, top: box.top, right: 0, height: box.height }}
                />
                <View className="absolute border-2 border-white" style={box} />
                {tool === "crop"
                  ? (
                      [
                        [box.left, box.top],
                        [box.left + box.width, box.top],
                        [box.left, box.top + box.height],
                        [box.left + box.width, box.top + box.height],
                      ] as const
                    ).map(([x, y]) => (
                      <View
                        key={`${x === box.left ? "left" : "right"}-${y === box.top ? "top" : "bottom"}`}
                        className="absolute rounded-full border-2 border-black/30 bg-white"
                        style={{
                          left: x - CROP_HANDLE_SIZE / 2,
                          top: y - CROP_HANDLE_SIZE / 2,
                          width: CROP_HANDLE_SIZE,
                          height: CROP_HANDLE_SIZE,
                        }}
                      />
                    ))
                  : null}
              </View>
            )}
          </View>
        ) : null}
      </View>
      <View className="flex-row items-center gap-1">
        <ToolButton
          icon="crop"
          label="Crop"
          selected={tool === "crop"}
          onPress={() => setTool("crop")}
        />
        <ToolButton
          icon="pencil"
          label="Draw"
          selected={tool === "draw"}
          onPress={() => setTool("draw")}
        />
        <View className="flex-1" />
        {tool === "draw" ? (
          <TextButton
            label="Undo"
            disabled={strokes.length === 0}
            onPress={() => setStrokes((done) => done.slice(0, -1))}
          />
        ) : null}
      </View>
    </View>
  );
}

function ToolButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected }}
      hitSlop={4}
      className={cn(
        "h-8 flex-row items-center gap-1.5 rounded-full px-3",
        props.selected ? "bg-input" : "",
      )}
      onPress={props.onPress}
    >
      <SymbolView
        name={props.icon}
        size={16}
        tintColorClassName={props.selected ? "accent-primary" : "accent-foreground-muted"}
      />
      <Text className="text-sm">{props.label}</Text>
    </Pressable>
  );
}

/** How far up, in pixels, the handle must be dragged to open the app. */
const OPEN_DRAG_DISTANCE = 40;

/**
 * The small arrow on top of the panel. A tap or a drag up continues in the app: the thread for
 * a thread, the new thread screen with the draft for a new thread.
 */
export function OpenInAppHandle(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onOpen: () => void;
}) {
  const [offset] = useState(() => new CoreAnimated.Value(0));
  const [startY, setStartY] = useState<number | null>(null);
  const settle = () =>
    CoreAnimated.spring(offset, { toValue: 0, useNativeDriver: true, bounciness: 6 }).start();
  const responder = props.disabled
    ? null
    : {
        onStartShouldSetResponder: () => true,
        onResponderTerminationRequest: () => false,
        onResponderGrant: (event: GestureResponderEvent) => setStartY(event.nativeEvent.pageY),
        onResponderMove: (event: GestureResponderEvent) => {
          if (startY === null) return;
          const dy = event.nativeEvent.pageY - startY;
          offset.setValue(Math.max(-OPEN_DRAG_DISTANCE * 1.5, Math.min(0, dy)));
        },
        onResponderRelease: (event: GestureResponderEvent) => {
          const dy = startY === null ? 0 : event.nativeEvent.pageY - startY;
          setStartY(null);
          settle();
          // A drag up opens the app, and so does a tap that barely moved.
          if (dy <= -OPEN_DRAG_DISTANCE || Math.abs(dy) < 8) props.onOpen();
        },
        onResponderTerminate: () => {
          setStartY(null);
          settle();
        },
      };
  return (
    <View className="items-center">
      <CoreAnimated.View
        accessible
        accessibilityRole="button"
        accessibilityLabel={props.label}
        accessibilityState={{ disabled: props.disabled }}
        // TalkBack sends a double tap as the activate action, not as a touch.
        accessibilityActions={props.disabled ? undefined : [{ name: "activate" }]}
        onAccessibilityAction={(event) => {
          if (!props.disabled && event.nativeEvent.actionName === "activate") props.onOpen();
        }}
        className={cn("h-6 w-14 items-center justify-center", props.disabled ? "opacity-40" : "")}
        style={{ transform: [{ translateY: offset }] }}
        {...responder}
      >
        <SymbolView name="chevron.up" size={18} tintColorClassName="accent-foreground-muted" />
      </CoreAnimated.View>
    </View>
  );
}

const GLOW_BANDS = 7;
const GLOW_BAND_WIDTH = 4;
const GLOW_WIDTH = GLOW_BANDS * GLOW_BAND_WIDTH;
const GLOW_GROW_MS = 700;
const GLOW_FADE_MS = 900;

/**
 * One edge of the glow: bands of the primary color that fade toward the middle. Bands of a
 * theme class, so the glow follows the theme without reading theme values in JS.
 */
function GlowEdge(props: { readonly side: "left" | "right" | "top" }) {
  return (
    <>
      {Array.from({ length: GLOW_BANDS }, (_, band) => (
        <View
          key={band}
          className="absolute bg-primary"
          style={{
            opacity: 0.32 * (1 - band / GLOW_BANDS) ** 2,
            ...(props.side === "top"
              ? { left: 0, right: 0, top: band * GLOW_BAND_WIDTH, height: GLOW_BAND_WIDTH }
              : {
                  top: 0,
                  bottom: 0,
                  [props.side]: band * GLOW_BAND_WIDTH,
                  width: GLOW_BAND_WIDTH,
                }),
          }}
        />
      ))}
    </>
  );
}

/**
 * Fork: the panel marks the screen with a glow instead of dimming the app under it. The glow
 * rises along both sides from the bottom, closes over the top, then fades after `seconds`.
 * It animates once per press, so it costs nothing while it rests.
 */
export function EdgeGlow(props: { readonly seconds: number | null }) {
  const reduceMotion = useReducedMotion();
  const grow = useSharedValue(reduceMotion ? 1 : 0);
  const shown = useSharedValue(1);
  const { seconds } = props;
  useEffect(() => {
    grow.set(
      withTiming(1, {
        duration: reduceMotion ? 0 : GLOW_GROW_MS,
        easing: Easing.out(Easing.cubic),
      }),
    );
    if (seconds !== null) {
      shown.set(withDelay(seconds * 1000, withTiming(0, { duration: GLOW_FADE_MS })));
    }
  }, [grow, shown, seconds, reduceMotion]);
  const containerStyle = useAnimatedStyle(() => ({ opacity: shown.get() }));
  const sideStyle = useAnimatedStyle(() => ({ transform: [{ scaleY: grow.get() }] }));
  // The top edge appears as the sides reach it.
  const topStyle = useAnimatedStyle(() => ({ opacity: Math.max(0, (grow.get() - 0.8) / 0.2) }));

  return (
    <Animated.View pointerEvents="none" className="absolute inset-0" style={containerStyle}>
      <Animated.View
        className="absolute bottom-0 left-0 top-0"
        style={[{ width: GLOW_WIDTH, transformOrigin: "bottom" }, sideStyle]}
      >
        <GlowEdge side="left" />
      </Animated.View>
      <Animated.View
        className="absolute bottom-0 right-0 top-0"
        style={[{ width: GLOW_WIDTH, transformOrigin: "bottom" }, sideStyle]}
      >
        <GlowEdge side="right" />
      </Animated.View>
      <Animated.View
        className="absolute left-0 right-0 top-0"
        style={[{ height: GLOW_WIDTH }, topStyle]}
      >
        <GlowEdge side="top" />
      </Animated.View>
    </Animated.View>
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
