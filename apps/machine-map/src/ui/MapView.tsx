import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import type {
  ArrowRecord,
  ClientRecord,
  MachineId,
  MachineLevel,
  MachineMapDocument,
  MachineRecord,
  MapChange,
  MapNote,
  MapPosition,
} from "@t3tools/contracts/machineMap";

import { usesText } from "../rules/access.ts";
import { findArrow, findClientArrow, findNote, MAP_FRAME } from "../rules/map.ts";
import { GrantBadges, LEVEL_SHORT } from "./AccessEditor.tsx";
import { NO_SELECTION } from "./route.ts";
import { usePortalContext } from "./context.ts";
import { buildStandings } from "./build.ts";
import { BuildLabel, BuildSticker } from "./BuildLabel.tsx";
import {
  arrowAsks,
  arrowEndWait,
  arrowEnds,
  connectMachines,
  cutLevel,
  type ArrowAsk,
} from "./derive.ts";
import { LEVEL_LABEL, PRESENCE_STICKER, presenceState, shortTime, timeAgo } from "./format.ts";
import { ClientIcon, ClockIcon, KindIcon, TimerIcon } from "./icons.tsx";
import {
  anyInView,
  autoLayout,
  fitView,
  separate,
  toMapPoint,
  toScreenPoint,
  zoomAt,
  clampZoom,
  type Box,
  type LayoutCard,
  type LayoutLink,
  type MapViewport,
  type Point,
  wireGeometry,
} from "./layout.ts";
import { NoteCard } from "./NoteCard.tsx";
import { settleHeld, type Held } from "./store.ts";
import { MachineStickers } from "./MachineStickers.tsx";
import { CardMeters } from "./resources.tsx";

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
/** MM-1121: room between two linked cards, in map pixels. A wire needs room for its badge. */
const LINK_ROOM = 120;
const WIRE_ROOM = 240;
/**
 * MM-1121: "Auto layout" keeps a card that would move less than this. The overlap pass nudges
 * cards a little, so without it a second click would make a new revision of tiny moves.
 */
const STILL_PIXELS = 20;
/** Pointer moves under this many pixels are a tap, not a drag. */
const TAP_PIXELS = 5;
/** MM-1110: holding a finger this long on empty map opens the add menu. */
const LONG_PRESS_MS = 550;
/** A map narrower than this uses the compact cards. The CSS class `compact` follows it. */
const COMPACT_WIDTH = 640;
/** Card sizes before the page measures them. The first paint already uses the measured sizes. */
const ESTIMATE = {
  wide: { node: { w: 224, h: 120 }, note: { w: 190, h: 80 } },
  compact: { node: { w: 156, h: 100 }, note: { w: 140, h: 60 } },
} as const;

/** MM-1116: the zoom and pan of this device. Each device keeps its own; the map never holds it. */
const VIEW_KEY = "machine-map:view";
/** Each "+" or "−" press zooms by this factor. */
const ZOOM_STEP = 1.25;
/** Wheel pixels to zoom: a trackpad pinch sends small steps, a mouse wheel big ones. */
const WHEEL_ZOOM_RATE = 0.005;
const WHEEL_ZOOM_MAX_DELTA = 50;
/** A wheel `deltaMode` of lines scrolls this many pixels per line. */
const LINE_PIXELS = 16;

function loadView(): MapViewport | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const { x, y, k } = value as Record<string, unknown>;
    if (typeof x !== "number" || typeof y !== "number" || typeof k !== "number") return null;
    if (![x, y, k].every(Number.isFinite) || k <= 0) return null;
    return { x, y, k: clampZoom(k) };
  } catch {
    return null;
  }
}

function storeView(view: MapViewport): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    // Private windows can refuse storage. The view then lasts until the page closes.
  }
}

/** A key press or a wheel in a text field or a select types or scrolls it; it never pans or zooms the map. */
const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Space on a button, a link, a card or in a dialog presses or types; it never pans the map. */
const keepsSpace = (target: EventTarget | null) =>
  document.querySelector("dialog[open]") !== null ||
  (target instanceof Element &&
    target.closest("button, a[href], [role='button'], summary, dialog") !== null);

interface Size {
  readonly w: number;
  readonly h: number;
}

/** What a drag moves: a machine (MM-206), a client (MM-904) or a note (MM-1109). */
type DragSubject =
  | { readonly _tag: "machine"; readonly machine: MachineRecord }
  | { readonly _tag: "client"; readonly client: ClientRecord }
  | { readonly _tag: "note"; readonly note: MapNote }
  /** MM-1104: a line from a handle of a machine. Dropping it on another machine connects them. */
  | { readonly _tag: "connect"; readonly machine: MachineRecord };

/** MM-1104: the edges of a machine card that hold a connection handle. */
const HANDLE_SIDES = ["top", "right", "bottom", "left"] as const;

/**
 * One drag in progress. Pointer moves change it in place and paint on the next frame, so a drag
 * does not render the map on every move. Points are card centers in map pixels.
 */
interface Drag {
  readonly subject: DragSubject;
  /** The card. It captures the pointer once the drag moves, so a tap still reaches its buttons. */
  readonly element: HTMLElement;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  /** Where the pointer holds the card, from its center, so the card does not jump. */
  readonly grab: Point;
  /** The card center before the drag. */
  readonly from: Point;
  clientX: number;
  clientY: number;
  at: Point;
  moved: boolean;
  /** MM-1104: the machine under the pointer while a connection line moves. Dropping here connects. */
  target: MachineId | null;
}

const samePosition = (a: MapPosition, b: MapPosition) => a.x === b.x && a.y === b.y;
const sameSizes = (a: Record<string, Size>, b: Record<string, Size>) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(b).every(([key, size]) => {
    const old = a[key];
    return old !== undefined && Math.abs(old.w - size.w) < 1 && Math.abs(old.h - size.h) < 1;
  });
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Enter and Space press a card that is not a button element. */
const onPressKey = (press: () => void) => (event: KeyboardEvent) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    press();
  }
};

/** The map, its moving layer or its line layer, not a card on it. */
const isEmptySpot = (target: EventTarget, map: EventTarget, world: EventTarget | null) =>
  target === map || target === world || (target instanceof Element && target.tagName === "svg");

/**
 * MM-1103: one directed curve per arrow, with the arrow state on a badge on the curve. `was` is
 * the level before the pause of an arrow that the pause cut (MM-717).
 */
interface Wire {
  readonly key: string;
  readonly from: MachineRecord;
  readonly to: MachineRecord;
  readonly arrow: ArrowRecord;
  readonly asks: ReadonlyArray<ArrowAsk>;
  readonly was: MachineLevel | null;
  readonly bowed: boolean;
}

/** A note that the page shows: a saved one, or a new one that is not saved yet. */
interface EditingNote {
  readonly note: MapNote;
  readonly saved: boolean;
}

export function MapView({ map, readOnly }: { map: MachineMapDocument; readOnly: boolean }) {
  const portal = usePortalContext();
  const { snapshot, route, now } = portal;
  const ref = useRef<HTMLDivElement>(null);
  /** MM-1116: the layer that holds every card. One CSS transform on it pans and zooms. */
  const worldRef = useRef<HTMLDivElement>(null);
  const view = useRef<MapViewport>({ x: 0, y: 0, k: 1 });
  const viewReady = useRef(false);
  const storeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A pan of the view: a drag on empty map, Space and a drag, or one finger on empty map. */
  const pan = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    from: MapViewport;
    moved: boolean;
  } | null>(null);
  /** The fingers on the map, by pointer id, in client pixels. Two of them pinch. */
  const touches = useRef(new Map<number, Point>());
  const pinch = useRef<{ distance: number; middle: Point; from: MapViewport } | null>(null);
  const spaceHeld = useRef(false);
  const hovered = useRef(false);
  /**
   * MM-1117: a plain wheel pans the live map only after a click, a drag or keyboard focus on it.
   * Before that, and after the pointer leaves or Esc, the wheel scrolls the page.
   */
  const engaged = useRef(false);
  /** False until the user zooms or pans, so the first "Fit" follows cards that grow (MM-1118). */
  const userMoved = useRef(false);
  const fittedFor = useRef("");
  /**
   * MM-1121: after "Auto layout", the revision that holds the new places. "Fit" runs once at it.
   * Each click makes a new object, so two clicks in one draft each fit.
   */
  const [fitAt, setFitAt] = useState<{ readonly revision: number } | null>(null);
  const fittedAt = useRef(fitAt);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  /** A drag that moved ends with a click on its card. That click is not a tap. */
  const swallowClick = useRef(false);
  const longPress = useRef<{
    timer: ReturnType<typeof setTimeout>;
    x: number;
    y: number;
  } | null>(null);
  /** The drop target, kept in state so the target card renders its look. */
  const [target, setTarget] = useState<MachineId | null>(null);
  /** MM-1104: the source machine of the connection line that follows the pointer. */
  const [linking, setLinking] = useState<MachineId | null>(null);
  /**
   * MM-1110: the add menu, at a point on the map and the screen point where it opened. A pan or
   * zoom closes it, so the screen point stays true.
   */
  const [menu, setMenu] = useState<{ readonly at: Point; readonly screen: Point } | null>(null);
  const [editing, setEditing] = useState<EditingNote | null>(null);
  // Each state keeps at most one entry per card. The save answer gives each entry its revision,
  // which the map then reaches, or removes the entry. So the page does not prune the state.
  const [heldPlaceState, setHeldPlaces] = useState<ReadonlyArray<Held<MapPosition>>>([]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Cards size to their text. Measure them after each render, before the browser paints, so the
  // layout below never paints with a guess.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const next: Record<string, Size> = {};
    for (const element of root.querySelectorAll<HTMLElement>("[data-size-key]")) {
      const key = element.dataset.sizeKey;
      if (key) next[key] = { w: element.offsetWidth, h: element.offsetHeight };
    }
    setSizes((current) => (sameSizes(current, next) ? current : next));
  });

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (longPress.current) clearTimeout(longPress.current.timer);
    },
    [],
  );

  useEffect(() => {
    if (!menu) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [menu]);

  const compact = size.width < COMPACT_WIDTH;
  const estimate = compact ? ESTIMATE.compact : ESTIMATE.wide;
  const machines = map.machines;
  const standings = buildStandings(snapshot.presence);
  const selection = route.selection;
  const focus = selection._tag === "machine" ? selection.id : null;
  const focusMachine = machines.find((m) => m.id === focus);
  // MM-1103: one wire per stored arrow, per arrow that a waiting proposal asks for, and, while
  // paused, per arrow that the pause cut (MM-717). An arrow at the default has no wire. The History
  // map shows no proposals: they belong to now, not to that revision.
  const wires: ReadonlyArray<Wire> = (() => {
    const ids = new Map<string, readonly [MachineId, MachineId]>();
    const add = (from: MachineId, to: MachineId) => ids.set(`${from}>${to}`, [from, to]);
    for (const arrow of map.arrows) add(arrow.from, arrow.to);
    const proposals = readOnly ? [] : snapshot.proposals;
    for (const proposal of proposals)
      for (const change of proposal.changes)
        if (change._tag === "setArrow") add(change.arrow.from, change.arrow.to);
    for (const cut of portal.pause?.cut ?? []) add(cut.from, cut.to);
    return [...ids].flatMap(([key, [fromId, toId]]): Array<Wire> => {
      const from = machines.find((m) => m.id === fromId);
      const to = machines.find((m) => m.id === toId);
      if (!from || !to) return [];
      const arrow = findArrow(map, fromId, toId);
      return [
        {
          key,
          from,
          to,
          arrow,
          asks: arrowAsks(proposals, fromId, toId),
          was: arrow.level === "none" ? cutLevel(portal.pause, fromId, toId) : null,
          bowed: ids.has(`${toId}>${fromId}`),
        },
      ];
    });
  })();

  // MM-1114: the map has no edges. Places are map pixels, so a card that grows or a new machine
  // never moves the other cards. Zoom and pan show any part of it (MM-1116, MM-1117).
  /** The size of the cards together. It changes when a card grows, never on a drop. */
  const cardArea = [
    ...machines.map((m) => sizes[`node:${m.id}`] ?? estimate.node),
    ...map.clients.map((c) => sizes[`client:${c.id}`] ?? estimate.node),
    ...map.notes.map((note) => sizes[`note:${note.id}`] ?? estimate.note),
  ].reduce((sum, { w, h }) => sum + w * h, 0);

  const heldPlaces = settleHeld(
    heldPlaceState,
    map.revision,
    (key) =>
      (
        map.machines.find((m) => `machine:${m.id}` === key) ??
        map.clients.find((c) => `client:${c.id}` === key) ??
        map.notes.find((n) => `note:${n.id}` === key)
      )?.position,
    samePosition,
  );

  const heldPlace = (key: string) => heldPlaces.find((h) => h.key === key)?.value;
  const position = (m: MachineRecord): MapPosition => heldPlace(`machine:${m.id}`) ?? m.position;
  const toPixels = (p: MapPosition): Point => p;
  /** A map point as a place to save, in whole map pixels. */
  const toPosition = (p: Point): MapPosition => ({ x: Math.round(p.x), y: Math.round(p.y) });
  const nodeBox = (m: MachineRecord, p: Point): Box => ({
    ...p,
    ...(sizes[`node:${m.id}`] ?? estimate.node),
  });

  const noteSize = (note: MapNote): Size => sizes[`note:${note.id}`] ?? estimate.note;
  const savedNoteAt = (note: MapNote): Point =>
    toPixels(heldPlace(`note:${note.id}`) ?? note.position);

  const clients = map.clients;
  const clientPlace = (c: ClientRecord): MapPosition => heldPlace(`client:${c.id}`) ?? c.position;
  const clientBox = (c: ClientRecord, p: Point): Box => ({
    ...p,
    ...(sizes[`client:${c.id}`] ?? estimate.node),
  });

  /**
   * Machines, clients and notes where the page shows them: saved places, pushed apart (see
   * `layout.ts`), so no card covers another on a narrow map (MM-1114).
   */
  const spread = separate([
    ...machines.map((m) => nodeBox(m, toPixels(position(m)))),
    ...clients.map((c) => clientBox(c, toPixels(clientPlace(c)))),
    ...map.notes.map((note) => ({ ...savedNoteAt(note), ...noteSize(note) })),
  ]);
  const nodes = spread.slice(0, machines.length);
  const clientBoxes = spread.slice(machines.length, machines.length + clients.length);
  const noteBoxes = spread.slice(machines.length + clients.length);
  const noteAt = (note: MapNote): Point =>
    noteBoxes[map.notes.findIndex((n) => n.id === note.id)] ?? savedNoteAt(note);
  const clientCenter = (c: ClientRecord): Point =>
    clientBoxes[clients.indexOf(c)] ?? toPixels(clientPlace(c));
  /**
   * MM-309, MM-717: client arrows above `none`, and while paused the ones the pause cut. They show
   * as tags on the machine cards, not as lines.
   */
  const clientLines = [
    ...map.clientArrows.map((arrow) => ({ arrow, cut: false })),
    ...(portal.pause?.cutClients ?? []).flatMap((cut) =>
      findClientArrow(map, cut.client, cut.to).level === "none"
        ? [{ arrow: { ...findClientArrow(map, cut.client, cut.to), level: cut.level }, cut: true }]
        : [],
    ),
  ].flatMap(({ arrow, cut }) => {
    const client = clients.find((c) => c.id === arrow.client);
    const machine = machines.find((m) => m.id === arrow.to);
    return client && machine ? [{ arrow, cut, client, machine }] : [];
  });

  /** Where each machine card goes. During a drag the dragged machine follows the pointer. */
  const layout = (dragged: { readonly id: MachineId; readonly at: Point } | null) =>
    new Map(
      machines.map((m, i) => [
        m.id,
        m.id === dragged?.id
          ? nodeBox(m, dragged.at)
          : (nodes[i] ?? nodeBox(m, toPixels(m.position))),
      ]),
    );
  const shown = layout(null);
  const centerOf = (m: MachineRecord): Point => shown.get(m.id) ?? toPixels(position(m));
  const wireAt = (wire: Wire, at: ReadonlyMap<MachineId, Box>) =>
    wireGeometry(
      at.get(wire.from.id) ?? nodeBox(wire.from, toPixels(position(wire.from))),
      at.get(wire.to.id) ?? nodeBox(wire.to, toPixels(position(wire.to))),
      wire.bowed,
    );

  const moveElement = (element: HTMLElement, p: Point) => {
    element.style.left = `${p.x}px`;
    element.style.top = `${p.y}px`;
  };

  /** Redraws each wire of the dragged machine and moves its badge, from the boxes of the drag. */
  const drawWires = (root: HTMLElement, id: MachineId, at: ReadonlyMap<MachineId, Box>) => {
    for (const wire of wires) {
      if (wire.from.id !== id && wire.to.id !== id) continue;
      const { d, badge } = wireAt(wire, at);
      root.querySelector(`path[data-wire="${CSS.escape(wire.key)}"]`)?.setAttribute("d", d);
      const element = root.querySelector<HTMLElement>(
        `.wire-badge[data-wire="${CSS.escape(wire.key)}"]`,
      );
      if (element) moveElement(element, badge);
    }
  };

  /** Writes the place of the dragged card straight to the page, with every line it moves. */
  const paint = (subject: DragSubject, p: Point, element: HTMLElement) => {
    const root = ref.current;
    if (!root) return;
    if (subject._tag === "connect") {
      const line = root.querySelector<SVGLineElement>("line.live");
      const from = centerOf(subject.machine);
      line?.setAttribute("x1", String(from.x));
      line?.setAttribute("y1", String(from.y));
      line?.setAttribute("x2", String(p.x));
      line?.setAttribute("y2", String(p.y));
      return;
    }
    moveElement(element, p);
    if (subject._tag === "machine")
      drawWires(root, subject.machine.id, layout({ id: subject.machine.id, at: p }));
  };

  /** A point on the screen in pixels of the map element, inside its border. */
  const screenAt = (clientX: number, clientY: number): Point => {
    const element = ref.current;
    if (!element) return { x: 0, y: 0 };
    const rect = element.getBoundingClientRect();
    return {
      x: clientX - rect.left - element.clientLeft,
      y: clientY - rect.top - element.clientTop,
    };
  };
  /** MM-1116: a client point in map pixels, through the zoom and pan, so drops save map places. */
  const mapAt = (clientX: number, clientY: number): Point =>
    toMapPoint(view.current, screenAt(clientX, clientY));

  /** Moves the drag to the last pointer. Runs at most once per frame. */
  const step = () => {
    const current = drag.current;
    if (!current || !current.moved) return;
    const { clientX, clientY } = current;
    const p = mapAt(clientX, clientY);
    current.at = {
      x: p.x - current.grab.x,
      y: p.y - current.grab.y,
    };
    if (current.subject._tag === "connect") {
      const id = current.subject.machine.id;
      const under = document
        .elementsFromPoint(clientX, clientY)
        .map((element) => element.closest<HTMLElement>("[data-machine-id]")?.dataset.machineId)
        .find((found) => found !== undefined && found !== id);
      const nextTarget = machines.find((m) => m.id === under)?.id ?? null;
      if (nextTarget !== current.target) {
        current.target = nextTarget;
        setTarget(nextTarget);
      }
    }
    paint(current.subject, current.at, current.element);
  };
  // The frame callback runs the newest step, so it paints with the newest map and size.
  const latestStep = useRef(step);
  useLayoutEffect(() => {
    latestStep.current = step;
    // A render during a drag, for example for a revision from another page, writes the saved
    // place. Put the dragged card back under the pointer before the browser paints.
    const current = drag.current;
    if (current?.moved) paint(current.subject, current.at, current.element);
  });

  const cancelFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };

  const cancelLongPress = () => {
    if (longPress.current) clearTimeout(longPress.current.timer);
    longPress.current = null;
  };

  /** The pointer in map pixels. */
  const pointerAt = (event: PointerEvent<HTMLElement>): Point =>
    mapAt(event.clientX, event.clientY);

  const startDrag = (event: PointerEvent<HTMLElement>, subject: DragSubject, center: Point) => {
    if (readOnly || event.button !== 0 || touches.current.size > 1) return;
    const grabAt = pointerAt(event);
    swallowClick.current = false;
    drag.current = {
      subject,
      element: event.currentTarget,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grab: { x: grabAt.x - center.x, y: grabAt.y - center.y },
      from: center,
      clientX: event.clientX,
      clientY: event.clientY,
      at: center,
      moved: false,
      target: null,
    };
  };

  /** MM-1116: writes the view to the map layer. No render: one transform moves every card. */
  const applyView = () => {
    const { x, y, k } = view.current;
    if (worldRef.current)
      worldRef.current.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  };
  /** Keeps the view of this device, after the gesture settles. A history map keeps none. */
  const keepView = () => {
    if (readOnly) return;
    if (storeTimer.current !== null) clearTimeout(storeTimer.current);
    storeTimer.current = setTimeout(() => {
      storeTimer.current = null;
      storeView(view.current);
    }, 250);
  };
  /** A user change of the view. Fit and the first view set `view` directly instead. */
  const setView = (next: MapViewport) => {
    userMoved.current = true;
    view.current = { ...next, k: clampZoom(next.k) };
    applyView();
    // The add menu sits at a screen point, so a pan or zoom closes it.
    if (menu) setMenu(null);
  };

  /** Every card as a box in map pixels. */
  const cardBoxes = (): Array<Box> => [
    ...machines.flatMap((m) => {
      const box = shown.get(m.id);
      return box ? [box] : [];
    }),
    ...clientBoxes,
    ...noteBoxes,
  ];
  /** MM-1116 "Fit": every card in view. An empty map shows its middle at 100%. */
  const fitted = (): MapViewport =>
    fitView(cardBoxes(), size.width, size.height) ?? {
      x: (size.width - MAP_FRAME.width) / 2,
      y: (size.height - MAP_FRAME.height) / 2,
      k: 1,
    };
  const fit = () => setView(fitted());
  const zoomBy = (factor: number) =>
    setView(zoomAt(view.current, { x: size.width / 2, y: size.height / 2 }, factor));

  // The first view: the kept view, or "Fit" on a first visit or when the kept view shows no card.
  // It waits for the measured card sizes, which come before the first paint. Until the user zooms
  // or pans, "Fit" runs again when a card or the map changes size; a dropped card keeps the view.
  // React never writes the transform, so each render puts it back.
  const measured =
    machines.length + clients.length + map.notes.length === 0 || Object.keys(sizes).length > 0;
  useLayoutEffect(() => {
    if (fitAt && fitAt !== fittedAt.current && map.revision >= fitAt.revision) {
      fittedAt.current = fitAt;
      userMoved.current = true;
      view.current = fitted();
      keepView();
    }
    if (size.width > 0 && measured) {
      const boxes = cardBoxes();
      // Card area changes when a card grows, never on a drop.
      const layout = [size.width, size.height, boxes.length, cardArea / 100]
        .map(Math.round)
        .join(",");
      if (!viewReady.current) {
        viewReady.current = true;
        const kept = readOnly ? null : loadView();
        if (kept && anyInView(kept, boxes, size.width, size.height)) {
          view.current = kept;
          userMoved.current = true;
        } else view.current = fitted();
        fittedFor.current = layout;
      } else if (!userMoved.current && fittedFor.current !== layout) {
        view.current = fitted();
        fittedFor.current = layout;
      }
    }
    applyView();
  });

  /**
   * MM-1121 "Auto layout": places every machine, client and note with `autoLayout`. It is one map
   * change, so Undo in the notice or in History puts every card back. A machine pair with a wire
   * keeps room for the wire badges. A client links to each machine that it uses, so it sits near
   * them, although it has no line.
   */
  const arrange = () => {
    const sizeOf = (key: string, fallback: Size): Size => sizes[key] ?? fallback;
    const nodeSize = (m: MachineRecord) => sizeOf(`node:${m.id}`, estimate.node);
    const cards: Array<LayoutCard> = [
      ...machines.map((m, i) => ({
        id: `machine:${m.id}`,
        ...(nodes[i] ?? nodeBox(m, toPixels(position(m)))),
      })),
      ...clients.map((c, i) => ({
        id: `client:${c.id}`,
        ...(clientBoxes[i] ?? clientBox(c, toPixels(clientPlace(c)))),
      })),
    ];
    // One link per machine pair, whichever way its wires run.
    const pairs = new Map(
      wires.map((wire) => {
        const [a, b] = [wire.from, wire.to].toSorted((x, y) => (x.id < y.id ? -1 : 1));
        return [`${a?.id}>${b?.id}`, [wire.from, wire.to] as const];
      }),
    );
    const links: Array<LayoutLink> = [
      ...[...pairs.values()].map(([a, b]) => ({
        a: `machine:${a.id}`,
        b: `machine:${b.id}`,
        length: (nodeSize(a).w + nodeSize(b).w) / 2 + WIRE_ROOM,
      })),
      ...clientLines.map(({ client, machine }) => ({
        a: `client:${client.id}`,
        b: `machine:${machine.id}`,
        length:
          (sizeOf(`client:${client.id}`, estimate.node).w + nodeSize(machine).w) / 2 +
          LINK_ROOM * 2,
      })),
    ];
    const placed = autoLayout(
      cards,
      links,
      noteBoxes,
      { x: MAP_FRAME.width / 2, y: MAP_FRAME.height / 2 },
      size.width / size.height,
    );
    const placeAt = (i: number) => toPosition(placed.cards[i] ?? { x: 0, y: 0 });
    const still = (a: MapPosition, b: MapPosition) =>
      Math.hypot(a.x - b.x, a.y - b.y) < STILL_PIXELS;
    const changes: Array<MapChange> = [
      ...machines.flatMap((machine, i): Array<MapChange> => {
        const next = placeAt(i);
        return still(next, machine.position)
          ? []
          : [{ _tag: "putMachine", machine: { ...machine, position: next } }];
      }),
      ...clients.flatMap((client, i): Array<MapChange> => {
        const next = placeAt(machines.length + i);
        return still(next, client.position)
          ? []
          : [{ _tag: "putClient", client: { ...client, position: next } }];
      }),
      ...map.notes.flatMap((note, i): Array<MapChange> => {
        const next = toPosition(placed.notes[i] ?? note.position);
        return still(next, note.position)
          ? []
          : [{ _tag: "putNote", note: { ...note, position: next } }];
      }),
    ];
    if (changes.length === 0) {
      fit();
      keepView();
      return;
    }
    // A held draft shows its places at once, with the same revision.
    void portal.submit("Auto layout", changes).then((outcome) => {
      if (outcome._tag === "applied") setFitAt({ revision: outcome.revision });
      else if (outcome._tag === "held") setFitAt({ revision: map.revision });
    });
  };

  /** Saves a waiting view at once: on unmount and when the page hides (MM-1118). */
  const flushView = () => {
    if (storeTimer.current === null) return;
    clearTimeout(storeTimer.current);
    storeTimer.current = null;
    storeView(view.current);
  };
  const latestFlush = useRef(flushView);
  useEffect(() => {
    const listener = () => latestFlush.current();
    addEventListener("pagehide", listener);
    return () => {
      removeEventListener("pagehide", listener);
      latestFlush.current();
    };
  }, []);

  const startPan = (event: PointerEvent<HTMLDivElement>) => {
    pan.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      from: view.current,
      moved: false,
    };
  };

  /** Ends a pan. True when the event belonged to it. */
  const endPan = (event: PointerEvent<HTMLDivElement>): boolean => {
    const current = pan.current;
    if (!current || current.pointerId !== event.pointerId) return false;
    pan.current = null;
    cancelLongPress();
    ref.current?.classList.remove("panning");
    // A pan that moved ends with a click on the map. That click is not a tap.
    if (current.moved) {
      swallowClick.current = true;
      keepView();
    }
    return true;
  };

  /**
   * MM-1116: fingers and Space. A second finger starts a pinch and stops the drag or pan of the
   * first. Space and a drag pan from anywhere, also over a card.
   */
  const onMapPointerDownCapture = (event: PointerEvent<HTMLDivElement>) => {
    engaged.current = true;
    if (event.pointerType === "touch") {
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.current.size === 2) {
        const [a, b] = [...touches.current.values()];
        if (!a || !b) return;
        abortDrag();
        pan.current = null;
        cancelLongPress();
        pinch.current = {
          distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
          middle: screenAt((a.x + b.x) / 2, (a.y + b.y) / 2),
          from: view.current,
        };
        event.stopPropagation();
        return;
      }
      if (touches.current.size > 2) event.stopPropagation();
    }
    if (spaceHeld.current && event.button === 0) {
      startPan(event);
      event.stopPropagation();
    }
  };

  /** MM-1110: a long press on empty map opens the add menu. A finger has no double click. */
  const onMapPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    swallowClick.current = false;
    if (event.button !== 0 || !isEmptySpot(event.target, event.currentTarget, worldRef.current))
      return;
    // MM-1116: a drag on empty map pans.
    startPan(event);
    if (readOnly || event.pointerType === "mouse") return;
    const point = pointerAt(event);
    cancelLongPress();
    longPress.current = {
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        longPress.current = null;
        swallowClick.current = true;
        setMenu({ at: point, screen: toScreenPoint(view.current, point) });
      }, LONG_PRESS_MS),
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const pinching = pinch.current;
    if (pinching && touches.current.has(event.pointerId)) {
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const [a, b] = [...touches.current.values()];
      if (!a || !b) return;
      const middle = screenAt((a.x + b.x) / 2, (a.y + b.y) / 2);
      const k = clampZoom((pinching.from.k * Math.hypot(b.x - a.x, b.y - a.y)) / pinching.distance);
      // The map point under the first middle follows the fingers.
      const p = toMapPoint(pinching.from, pinching.middle);
      setView({ k, x: middle.x - p.x * k, y: middle.y - p.y * k });
      return;
    }
    const panning = pan.current;
    if (panning && panning.pointerId === event.pointerId) {
      const dx = event.clientX - panning.startX;
      const dy = event.clientY - panning.startY;
      if (!panning.moved && Math.hypot(dx, dy) > TAP_PIXELS) {
        panning.moved = true;
        cancelLongPress();
        ref.current?.setPointerCapture(event.pointerId);
        ref.current?.classList.add("panning");
      }
      if (panning.moved)
        setView({ ...panning.from, x: panning.from.x + dx, y: panning.from.y + dy });
      return;
    }
    const press = longPress.current;
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_PIXELS)
      cancelLongPress();
    const current = drag.current;
    if (!current) return;
    current.clientX = event.clientX;
    current.clientY = event.clientY;
    if (
      !current.moved &&
      Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > TAP_PIXELS
    ) {
      current.moved = true;
      // Only a moving drag takes the pointer: a tap on a pair row stays a click on that row.
      current.element.setPointerCapture(current.pointerId);
      if (current.subject._tag === "connect") setLinking(current.subject.machine.id);
      // The dragged card rides above every other card.
      else current.element.classList.add("dragging");
    }
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      latestStep.current();
    });
  };

  /** Ends the drag and paints the place that the next render shows. */
  const endDrag = (event: PointerEvent<HTMLDivElement>): Drag | null => {
    cancelLongPress();
    const current = drag.current;
    if (!current) return null;
    current.clientX = event.clientX;
    current.clientY = event.clientY;
    cancelFrame();
    step();
    drag.current = null;
    current.element.classList.remove("dragging");
    setTarget(null);
    setLinking(null);
    swallowClick.current = current.moved;
    return current;
  };

  const toggle = (machine: MachineRecord) =>
    portal.select(focus === machine.id ? NO_SELECTION : { _tag: "machine", id: machine.id });

  /**
   * A dropped machine or client settles beside the other cards, not on top of one. The others
   * stay. `index` counts in the order of `spread`: machines, then clients, then notes.
   */
  const settle = (index: number, dropped: Box): MapPosition => {
    const boxes = spread.map((box, i) => (i === index ? dropped : box));
    const fixed = new Set([...boxes.keys()].filter((i) => i !== index));
    return toPosition(separate(boxes, fixed)[index] ?? dropped);
  };

  /**
   * Saves a dropped place. The page holds it until the map has it (no snap back). A held draft
   * shows through the map; a proposal or a failure shows the saved place.
   */
  const save = <T,>(
    setHeld: (update: (current: ReadonlyArray<Held<T>>) => ReadonlyArray<Held<T>>) => void,
    key: string,
    value: T,
    summary: string,
    change: MapChange,
  ) => {
    const hold: Held<T> = { key, value, revision: null };
    setHeld((current) => [...current.filter((h) => h.key !== key), hold]);
    void portal
      .submit(summary, [change], { quiet: true })
      .then((outcome) =>
        setHeld((current) =>
          outcome._tag === "applied"
            ? current.map((h) => (h === hold ? { ...h, revision: outcome.revision } : h))
            : current.filter((h) => h !== hold),
        ),
      );
  };

  /** Forgets a finger. A pinch ends when fewer than two stay; its click is not a tap. */
  const releaseTouch = (event: PointerEvent<HTMLDivElement>) => {
    touches.current.delete(event.pointerId);
    if (pinch.current && touches.current.size < 2) {
      pinch.current = null;
      swallowClick.current = true;
      keepView();
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    releaseTouch(event);
    if (endPan(event)) return;
    const finished = endDrag(event);
    if (!finished) return;
    const { subject } = finished;
    if (!finished.moved) {
      if (subject._tag === "machine") toggle(subject.machine);
      if (subject._tag === "client") portal.select({ _tag: "client", id: subject.client.id });
      // A tap on a handle opens the machine, where "Connect to" works without a drag.
      if (subject._tag === "connect") portal.select({ _tag: "machine", id: subject.machine.id });
      return;
    }
    switch (subject._tag) {
      case "machine": {
        const machine = subject.machine;
        const settled = settle(
          machines.findIndex((m) => m.id === machine.id),
          nodeBox(machine, finished.at),
        );
        paint(subject, toPixels(settled), finished.element);
        if (samePosition(settled, toPosition(finished.from))) return;
        save(setHeldPlaces, `machine:${machine.id}`, settled, `Moved ${machine.name}`, {
          _tag: "putMachine",
          machine: { ...machine, position: settled },
        });
        return;
      }
      case "client": {
        const client = subject.client;
        const placed = settle(
          machines.length + clients.findIndex((c) => c.id === client.id),
          clientBox(client, finished.at),
        );
        paint(subject, toPixels(placed), finished.element);
        if (samePosition(placed, toPosition(finished.from))) return;
        save(setHeldPlaces, `client:${client.id}`, placed, `Moved ${client.name}`, {
          _tag: "putClient",
          client: { ...client, position: placed },
        });
        return;
      }
      case "connect": {
        // A drop on empty map cancels.
        const to = machines.find((m) => m.id === finished.target);
        if (to) connectMachines(portal, subject.machine, to);
        return;
      }
      case "note": {
        const note = subject.note;
        const placed = toPosition(finished.at);
        if (samePosition(placed, note.position)) return;
        save(setHeldPlaces, `note:${note.id}`, placed, "Moved a note", {
          _tag: "putNote",
          note: { ...note, position: placed },
        });
        return;
      }
    }
  };

  /** Puts a dragged card back where it was, for a cancelled drag. */
  const putBack = (finished: Drag) => {
    if (finished.moved) paint(finished.subject, finished.from, finished.element);
  };

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    releaseTouch(event);
    if (endPan(event)) return;
    const finished = endDrag(event);
    if (finished) putBack(finished);
  };

  /** MM-1116: a pinch stops a card drag that the first finger started. */
  const abortDrag = () => {
    const current = drag.current;
    if (!current) return;
    cancelFrame();
    drag.current = null;
    current.element.classList.remove("dragging");
    setTarget(null);
    setLinking(null);
    putBack(current);
  };

  /**
   * MM-1116, MM-1117: Ctrl or Cmd and the wheel, or a trackpad pinch (the browser sends it with
   * Ctrl), zoom at the pointer. A plain wheel or a two-finger scroll pans the live map once it is
   * engaged; otherwise, and on the History map, it scrolls the page. A note in edit mode scrolls.
   */
  const onWheel = (event: WheelEvent) => {
    if (isTyping(event.target)) return;
    const zoom = event.ctrlKey || event.metaKey;
    if (!zoom && (readOnly || !engaged.current)) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? LINE_PIXELS : 1;
    if (zoom) {
      const delta = clamp(event.deltaY * unit, -WHEEL_ZOOM_MAX_DELTA, WHEEL_ZOOM_MAX_DELTA);
      setView(
        zoomAt(
          view.current,
          screenAt(event.clientX, event.clientY),
          Math.exp(-delta * WHEEL_ZOOM_RATE),
        ),
      );
    } else {
      setView({
        ...view.current,
        x: view.current.x - event.deltaX * unit,
        y: view.current.y - event.deltaY * unit,
      });
    }
    keepView();
  };
  const latestWheel = useRef(onWheel);
  // React adds wheel listeners as passive, and a passive listener cannot stop the page scroll.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const listener = (event: WheelEvent) => latestWheel.current(event);
    element.addEventListener("wheel", listener, { passive: false });
    return () => element.removeEventListener("wheel", listener);
  }, []);

  // A finger that lifts outside the map never reaches its handlers. Forget it there too, so a
  // later single finger does not count as a pinch.
  useEffect(() => {
    const forget = (event: globalThis.PointerEvent) => {
      touches.current.delete(event.pointerId);
      if (touches.current.size < 2) pinch.current = null;
      // A fast flick can leave the map before the pan takes the pointer. End that pan here, so
      // hovering later does not pan the map.
      if (pan.current?.pointerId === event.pointerId) {
        pan.current = null;
        ref.current?.classList.remove("panning");
      }
    };
    addEventListener("pointerup", forget);
    addEventListener("pointercancel", forget);
    return () => {
      removeEventListener("pointerup", forget);
      removeEventListener("pointercancel", forget);
    };
  }, []);

  /** MM-1116: Space held over the map pans with a drag. "0" fits every card. */
  const onKey = (event: globalThis.KeyboardEvent) => {
    if (isTyping(event.target)) return;
    if (event.key === "Escape") engaged.current = false;
    if (event.key === " ") {
      // A button presses on key up, so only a Space that the map took ends with the map.
      if (event.type === "keyup") {
        if (!spaceHeld.current) return;
        event.preventDefault();
        spaceHeld.current = false;
        ref.current?.classList.remove("space-pan");
        return;
      }
      if (keepsSpace(event.target)) {
        // A modal over the map gets no pointer leave, so the map forgets the hover here.
        if (document.querySelector("dialog[open]")) hovered.current = false;
        return;
      }
      if (!hovered.current && !spaceHeld.current) return;
      event.preventDefault();
      spaceHeld.current = true;
      ref.current?.classList.add("space-pan");
      return;
    }
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    if (event.type === "keydown" && event.key === "0" && plain) {
      fit();
      keepView();
    }
  };
  const latestKey = useRef(onKey);
  useLayoutEffect(() => {
    latestWheel.current = onWheel;
    latestKey.current = onKey;
    latestFlush.current = flushView;
  });
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => latestKey.current(event);
    const release = () => {
      spaceHeld.current = false;
      ref.current?.classList.remove("space-pan");
    };
    addEventListener("keydown", listener);
    addEventListener("keyup", listener);
    addEventListener("blur", release);
    return () => {
      removeEventListener("keydown", listener);
      removeEventListener("keyup", listener);
      removeEventListener("blur", release);
    };
  }, []);

  /** MM-1103: a tap on the empty map ends the focus and closes the add menu. */
  const onMapClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!isEmptySpot(event.target, event.currentTarget, worldRef.current)) return;
    setMenu(null);
    if (selection._tag !== "none") portal.select(NO_SELECTION);
  };

  /** MM-1110: a double click on empty map opens the add menu there. */
  const onMapDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (readOnly || !isEmptySpot(event.target, event.currentTarget, worldRef.current)) return;
    setMenu({
      at: mapAt(event.clientX, event.clientY),
      screen: screenAt(event.clientX, event.clientY),
    });
  };

  const saveNote = (note: MapNote, saved: boolean) => {
    setEditing(null);
    const before = findNote(map, note.id);
    if (before && before.text === note.text && before.color === note.color) return;
    void portal.submit(saved ? "Edited a note" : "Added a note", [{ _tag: "putNote", note }]);
  };

  /** MM-602, MM-604: the wait of each arrow end that did not apply the arrow, in words. */
  const waitOf = (from: MachineRecord, to: MachineRecord): Array<string> => {
    if (readOnly) return [];
    const ends = arrowEnds(snapshot, from.id, to.id);
    return [[ends.from, from] as const, [ends.to, to] as const].flatMap(([end, machine]) => {
      const text = arrowEndWait(end, machine);
      return text === null || end === "applied" ? [] : [sentence(text)];
    });
  };

  const notes: ReadonlyArray<EditingNote> = [
    ...map.notes.map((note) => (editing?.note.id === note.id ? editing : { note, saved: true })),
    ...(editing && !editing.saved ? [editing] : []),
  ];

  return (
    <div className="map-wrap">
      {/* The bar keeps its height in every state, so the map never moves when focus changes. */}
      {!readOnly && (
        <div className="map-bar" role="status">
          {focusMachine ? (
            <>
              <span>
                Arrows of <b>{focusMachine.name}</b>
              </span>
              <button
                type="button"
                className="btn small"
                aria-keyshortcuts="Escape"
                onClick={() => portal.select(NO_SELECTION)}
              >
                Show all <kbd>Esc</kbd>
              </button>
            </>
          ) : (
            <span className="muted">
              {compact
                ? "Tap a machine to focus it. Drag a dot to connect. Hold empty space to add. Pinch to zoom."
                : "Tap a machine to focus it. Drag a dot on its edge onto another machine to connect them. Double-click empty space to add a machine or a note. Drag empty space to pan, Ctrl or Cmd and the wheel to zoom."}
            </span>
          )}
        </div>
      )}
      <div
        className={`card map${compact ? " compact" : ""}${focus ? " focused" : ""}${readOnly ? " map-readonly" : ""}`}
        ref={ref}
        onClick={onMapClick}
        onClickCapture={(event) => {
          if (!swallowClick.current) return;
          swallowClick.current = false;
          event.stopPropagation();
        }}
        onDoubleClick={onMapDoubleClick}
        onPointerDownCapture={onMapPointerDownCapture}
        onPointerDown={onMapPointerDown}
        onPointerEnter={() => {
          hovered.current = true;
        }}
        onPointerLeave={() => {
          hovered.current = false;
          engaged.current = false;
        }}
        onFocus={() => {
          engaged.current = true;
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) engaged.current = false;
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <div className="map-world" ref={worldRef}>
          <svg aria-hidden>
            <defs>
              <marker
                id="wire-head"
                viewBox="0 0 10 10"
                refX="5"
                refY="5"
                markerWidth="3.2"
                markerHeight="3.2"
                orient="auto"
              >
                <path d="M0,0L10,5L0,10z" />
              </marker>
            </defs>
            {wires.map((wire) => {
              const on =
                selection._tag === "arrow" &&
                selection.from === wire.from.id &&
                selection.to === wire.to.id;
              const touches = focus === wire.from.id || focus === wire.to.id;
              return (
                <path
                  key={wire.key}
                  data-wire={wire.key}
                  d={wireAt(wire, shown).d}
                  markerEnd="url(#wire-head)"
                  className={[
                    "wire",
                    `lvl-${wire.was ?? wire.arrow.level}`,
                    wire.arrow.expiresAt && "temp",
                    wire.arrow.level === "none" && wire.asks.length > 0 && !wire.was && "ask",
                    wire.was && "cut",
                    on && "on",
                    focus && (touches ? "hot" : "dim"),
                  ]
                    .filter(Boolean)
                    .join(" ")}
                />
              );
            })}
            {linking !== null && <line className="live" />}
          </svg>
          {size.width > 0 &&
            notes.map(({ note, saved }) => (
              <NoteCard
                key={note.id}
                note={note}
                saved={saved}
                at={noteAt(note)}
                readOnly={readOnly}
                editing={editing?.note.id === note.id}
                onPointerDown={(event) => startDrag(event, { _tag: "note", note }, noteAt(note))}
                onEdit={() => setEditing({ note, saved: true })}
                onCancel={() => setEditing(null)}
                onSave={(text, color) => saveNote({ ...note, text, color }, saved)}
                onDelete={() => {
                  setEditing(null);
                  void portal.submit("Deleted a note", [{ _tag: "removeNote", id: note.id }]);
                }}
              />
            ))}
          {size.width > 0 &&
            wires.map((wire) => {
              const { badge } = wireAt(wire, shown);
              const on =
                selection._tag === "arrow" &&
                selection.from === wire.from.id &&
                selection.to === wire.to.id;
              const dim = focus !== null && focus !== wire.from.id && focus !== wire.to.id;
              const waits = waitOf(wire.from, wire.to);
              const ask = wire.asks[0]?.arrow;
              // MM-804: an arrow that only a proposal asks for says what it asks.
              const asking = wire.arrow.level === "none" && ask !== undefined && !wire.was;
              const state = wire.was
                ? `cut by the pause, was ${LEVEL_LABEL[wire.was]}`
                : LEVEL_LABEL[wire.arrow.level];
              return (
                <button
                  key={wire.key}
                  type="button"
                  data-wire={wire.key}
                  className={`wire-badge${on ? " on" : ""}${dim ? " dim" : ""}${asking ? " ask" : ""}${wire.was ? " cut" : ""}`}
                  style={{ left: badge.x, top: badge.y }}
                  aria-label={`${usesText(wire.from.name, wire.to.name)}: ${state}${ask ? `. Asks for ${LEVEL_LABEL[ask.level]}` : ""}${waits.length > 0 ? `. ${waits.join(". ")}` : ""}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() =>
                    portal.select({ _tag: "arrow", from: wire.from.id, to: wire.to.id })
                  }
                >
                  {wire.was ? (
                    <>
                      <span className={`lvl-pill lvl-${wire.was} was`}>
                        {LEVEL_SHORT[wire.was]}
                      </span>
                      <span className="cut-word">cut</span>
                    </>
                  ) : asking ? (
                    <span className="ask-word">asks {LEVEL_SHORT[ask.level]}</span>
                  ) : (
                    <GrantBadges
                      grant={{ _tag: "machine", from: wire.from, to: wire.to, arrow: wire.arrow }}
                      now={now}
                      short
                    />
                  )}
                  {!asking && ask && (
                    <span className="ask-dot" data-tip={`Asks for ${LEVEL_LABEL[ask.level]}`}>
                      ?
                    </span>
                  )}
                  {waits.length > 0 && <ClockIcon label={waits.join(". ")} />}
                </button>
              );
            })}
          {size.width > 0 &&
            clients.map((client) => {
              const p = clientCenter(client);
              const on = selection._tag === "client" && selection.id === client.id;
              return (
                <div
                  key={client.id}
                  data-size-key={`client:${client.id}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={on}
                  aria-label={`${client.name}, client`}
                  className={`card node client${on ? " on" : ""}${readOnly ? " readonly" : ""}`}
                  style={{ left: p.x, top: p.y }}
                  onPointerDown={(event) => startDrag(event, { _tag: "client", client }, p)}
                  onClick={
                    readOnly ? () => portal.select({ _tag: "client", id: client.id }) : undefined
                  }
                  onKeyDown={onPressKey(() => portal.select({ _tag: "client", id: client.id }))}
                >
                  <span className="sticker state">client</span>
                  <div className="name">
                    <span className="icon">
                      <ClientIcon />
                    </span>
                    <span className="label">
                      {client.name}
                      <span className="sub">
                        {client.keys.length === 1 ? "1 browser" : `${client.keys.length} browsers`}
                      </span>
                    </span>
                  </div>
                  {/* MM-904: its levels show as tags on the machine cards it uses. */}
                  <div className="sub ports-note">
                    {(() => {
                      const used = clientLines.filter((line) => line.client.id === client.id);
                      return used.length === 0
                        ? "Uses no machine yet."
                        : `Uses ${used.map((line) => line.machine.name).join(", ")}.`;
                    })()}
                  </div>
                </div>
              );
            })}
          {size.width > 0 &&
            machines.map((machine) => {
              const p = centerOf(machine);
              const presence = snapshot.presence[machine.id];
              const state = presenceState(presence);
              const status = presence?.status ?? null;
              const on = focus === machine.id;
              const dropTarget = target === machine.id;
              // MM-1002: the build gets its own line under the name, so it never cuts off.
              const build = state === "online" && status ? status : null;
              const sub =
                state === "waiting"
                  ? "Waiting to join"
                  : state === "offline"
                    ? `Seen ${timeAgo(presence?.lastSeenAt ?? null, now)}`
                    : build
                      ? null
                      : (machine.hostname ?? "No status yet");
              return (
                <div
                  key={machine.id}
                  data-machine-id={machine.id}
                  data-size-key={`node:${machine.id}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={on}
                  aria-label={`${machine.name}, ${state}`}
                  className={`card node${on ? " on" : ""}${dropTarget ? " target" : ""}${linking === machine.id ? " linking" : ""}${readOnly ? " readonly" : ""}`}
                  style={{ left: p.x, top: p.y }}
                  onPointerDown={(event) =>
                    startDrag(event, { _tag: "machine", machine }, centerOf(machine))
                  }
                  onClick={
                    readOnly ? () => portal.select({ _tag: "machine", id: machine.id }) : undefined
                  }
                  onKeyDown={onPressKey(() => toggle(machine))}
                >
                  <span className={`sticker state ${PRESENCE_STICKER[state]}`}>{state}</span>
                  {!readOnly &&
                    HANDLE_SIDES.map((side) => (
                      // Pointer only: the machine panel has "Connect to" for the keyboard.
                      <span
                        key={side}
                        className={`handle ${side}`}
                        aria-hidden
                        data-tip="Drag onto a machine to connect"
                        data-tip-side={side}
                        onPointerDown={(event) => {
                          // The handle starts a line, not a move of its machine.
                          event.stopPropagation();
                          startDrag(event, { _tag: "connect", machine }, pointerAt(event));
                        }}
                      />
                    ))}
                  <div className="name">
                    <span className="icon">
                      <KindIcon kind={machine.kind} />
                    </span>
                    <span className="label">
                      {machine.name}
                      {sub !== null && <span className="sub">{sub}</span>}
                    </span>
                  </div>
                  {build && (
                    <div className="build-line">
                      <BuildLabel status={build} />
                    </div>
                  )}
                  {!readOnly && <CardMeters machineId={machine.id} />}
                  <div className="tags">
                    <BuildSticker standing={standings.get(machine.id)} />
                    {!readOnly && <MachineStickers machine={machine} />}
                  </div>
                  <MachinePorts
                    machine={machine}
                    lines={clientLines.filter((line) => line.machine.id === machine.id)}
                  />
                </div>
              );
            })}
        </div>
        {menu && (
          <div
            className="card map-menu"
            role="menu"
            aria-label="Add here"
            style={{
              left: clamp(menu.screen.x, 8, Math.max(8, size.width - 220)),
              top: clamp(menu.screen.y, 8, Math.max(8, size.height - 180)),
            }}
          >
            <button
              type="button"
              role="menuitem"
              className="btn small"
              autoFocus
              onClick={() => {
                setMenu(null);
                portal.open({ _tag: "addMachine", position: toPosition(menu.at) });
              }}
            >
              Add machine here
            </button>
            <button
              type="button"
              role="menuitem"
              className="btn small"
              onClick={() => {
                setMenu(null);
                portal.open({ _tag: "addPhone", position: toPosition(menu.at) });
              }}
            >
              Add phone here
            </button>
            <button
              type="button"
              role="menuitem"
              className="btn small"
              onClick={() => {
                setMenu(null);
                setEditing({
                  note: {
                    id: crypto.randomUUID(),
                    // The editor opens empty. An empty note is never saved.
                    text: "",
                    color: "yellow",
                    position: toPosition(menu.at),
                  },
                  saved: false,
                });
              }}
            >
              Add note here
            </button>
          </div>
        )}
        {machines.length === 0 && (
          <div className="empty map-empty">
            <span className="stamp">empty</span>
            <h2>No machines yet</h2>
            <p>Add the first machine. It joins with a one-time code and shows here.</p>
            {!readOnly && (
              <div className="actions">
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => portal.open({ _tag: "addMachine" })}
                >
                  Add machine
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => portal.open({ _tag: "addPhone" })}
                >
                  Add phone
                </button>
              </div>
            )}
          </div>
        )}
        {/* MM-1116, MM-1121: zoom in, zoom out, fit and auto layout, in a corner over the map. */}
        <div className="map-zoom" role="group" aria-label="Zoom and layout">
          <button
            type="button"
            className="btn small"
            aria-label="Zoom in"
            data-tip="Zoom in (Ctrl or Cmd and the wheel)"
            onClick={() => {
              zoomBy(ZOOM_STEP);
              keepView();
            }}
          >
            +
          </button>
          <button
            type="button"
            className="btn small"
            aria-label="Zoom out"
            data-tip="Zoom out"
            onClick={() => {
              zoomBy(1 / ZOOM_STEP);
              keepView();
            }}
          >
            −
          </button>
          <button
            type="button"
            className="btn small"
            aria-keyshortcuts="0"
            data-tip="Show every card (0)"
            onClick={() => {
              fit();
              keepView();
            }}
          >
            Fit
          </button>
          {!readOnly && (
            <button
              type="button"
              className="btn small"
              aria-label="Auto layout"
              disabled={machines.length + clients.length + map.notes.length === 0}
              data-tip="Place every card so the map reads well. Undo puts them back."
              onClick={arrange}
            >
              {compact ? "Auto" : "Auto layout"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * MM-904: the clients that use a machine, as tags on its card, and its map role. A tag opens the
 * client arrow. Clients get no lines, so a phone never crosses the machine wires.
 */
function MachinePorts({
  machine,
  lines,
}: {
  machine: MachineRecord;
  lines: ReadonlyArray<{
    readonly arrow: { readonly level: MachineLevel; readonly expiresAt: string | null };
    readonly cut: boolean;
    readonly client: ClientRecord;
  }>;
}) {
  const portal = usePortalContext();
  const role = machine.mapRole === "propose" || machine.mapRole === "edit" ? machine.mapRole : null;
  if (role === null && lines.length === 0) return null;
  return (
    <div className="ports">
      {role && (
        <span
          className="port role"
          data-tip={`Agents here ${role === "edit" ? "change" : "propose changes to"} the map`}
        >
          map {role}
        </span>
      )}
      {lines.map(({ arrow, cut, client }) => (
        <button
          key={client.id}
          type="button"
          className={`port lvl-${arrow.level}${cut ? " was" : ""}`}
          data-tip={`${usesText(client.name, machine.name)}: ${cut ? `cut by the pause, was ${LEVEL_LABEL[arrow.level]}` : LEVEL_LABEL[arrow.level]}${arrow.expiresAt ? `, until ${shortTime(arrow.expiresAt)}` : ""}`}
          aria-label={`${usesText(client.name, machine.name)}: ${cut ? `cut, was ${LEVEL_LABEL[arrow.level]}` : LEVEL_LABEL[arrow.level]}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            portal.select({ _tag: "clientArrow", client: client.id, to: machine.id });
          }}
        >
          <ClientIcon />
          {client.name} {LEVEL_SHORT[arrow.level]}
          {arrow.expiresAt && <TimerIcon />}
        </button>
      ))}
    </div>
  );
}
