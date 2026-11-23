import { Spinner } from "@grasp-os/ui/components/spinner";
import { fadeIn, focusRing } from "@grasp-os/ui/lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius as radii,
  shadow,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { nameWidth } from "../atlas-map.ts";
import { CLOUD_PITCH } from "../dot-shapes.ts";
import { DOT_FLOATS, makePainter, MOST_DOTS } from "./dive-painters.ts";
import {
  arrived,
  layOut,
  printLive,
  printThreads,
  settle,
} from "./dive-print.ts";
import type { LiveNeuron } from "./dive-print.ts";
import {
  DIVE,
  flightPose,
  onPlane,
  planeOf,
  project,
  REST,
  roomOf,
  smooth,
  viewProjection,
} from "./dive-scene.ts";
import type { DiveClear, Pose, Screen } from "./dive-scene.ts";
import { NAME } from "./layout.ts";
import type { ThinkingMap, ThinkingNeuron } from "./layout.ts";
import { markShared } from "./same-pain.ts";
import { thinkingMap } from "./shapes.ts";
import type { Thought } from "./shapes.ts";
import { WorkHours } from "./work-hours.tsx";

// Grasp's thinking as a dive into the brain (grasplabs/prototype
// `components/knowledge/thinking-dive.tsx`), on the page's own light
// ground, in the brain's ink. When Grasp starts to think, the camera flies
// in through the brain's brow once and comes to rest, still; inside, the
// shape of the thinking stands as the brain's own neurons (neurons.ts), its
// threads as the atlas draws its nerves, each beat bolder and warm on what
// it reads while the rest steps back. A new step moves in order
// (dive-print.ts). Names stand under their neurons and the line that says
// what Grasp does over the shape. Drawn in WebGL, or on a 2D canvas, still,
// where that won't start (dive-painters.ts); the resolution steps down if
// frames come slowly. With less motion it is already inside and nothing
// moves. It fades as the thought goes. The flight is work still going on,
// so it takes longer than a control's motion.

/** Of the flight: when the line shows, when the shape grows in, and when the names show. */
const CAPTION_FROM = 0.15;
const SHAPE_FROM = 0.55;
const SAYS_FROM = 0.82;

/** Pixels per world unit, as a share of the room, as the atlas scales a region: so a neuron in the dive is as fine as in its region. */
const FILL = 0.33;
const TALL = 1.34;
/** A map prints at half the brain's spacing. */
const FINE = 0.5;
/** How far the pointer may be from a soma to count as over it. */
const NEAR = 14;

/** Hidden until the drawing says it shows (`data-shown`, set each frame by `settle`). */
const hidden = ":is([data-shown=false])";

const styles = stylex.create({
  // The dive over the page's own ground; it fades as the thought goes.
  dive: {
    position: "absolute",
    inset: 0,
    overflow: "hidden",
    backgroundColor: colors.background,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    opacity: { default: 1, [hidden]: 0 },
    pointerEvents: { default: null, [hidden]: "none" },
    transitionProperty: { default: "opacity", [media.reducedMotion]: "none" },
    transitionDuration: duration.ui,
    transitionTimingFunction: duration.ease,
  },
  pointing: { cursor: "pointer" },
  canvas: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    backgroundColor: `color-mix(in oklch, ${colors.muted} 30%, transparent)`,
  },
  // Where the drawing places a name or the line, by its transform; it shows as the drawing says.
  placed: {
    position: "absolute",
    insetBlockStart: 0,
    insetInlineStart: 0,
    pointerEvents: "none",
    opacity: { default: 1, [hidden]: 0 },
    transitionProperty: "opacity",
    transitionDuration: duration.mark,
    transitionTimingFunction: duration.ease,
  },
  up: { zIndex: 10 },
  name: {
    maxWidth: "var(--cell)",
    paddingBlock: 2,
    paddingInline: space["1"],
    borderRadius: radii.mark,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: 1.25,
    fontWeight: font.weightMedium,
    textAlign: "center",
    translate: "-50% 0",
    // Pressable while it shows; never while it is hidden.
    pointerEvents: {
      default: "auto",
      [stylex.when.ancestor(hidden)]: "none",
    },
  },
  // Words cut at their line (two, or four for what was said), the cut marked with an ellipsis.
  clamp: {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  clampTwo: { WebkitLineClamp: 2 },
  clampFour: { WebkitLineClamp: 4 },
  said: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    width: "var(--said)",
    maxWidth: "var(--said)",
    paddingBlock: space["1"],
    paddingInline: 6,
    fontWeight: font.weightNormal,
  },
  small: { fontSize: font.textXs, lineHeight: 1.25 },
  waiting: { color: colors.mutedForeground },
  column: { display: "flex", flexDirection: "column" },
  saidWords: { paddingBlockEnd: space["1"], textWrap: "balance" },
  shared: {
    textDecorationLine: "underline",
    textDecorationColor: colors.mutedForeground,
    textUnderlineOffset: space["1"],
  },
  by: { color: colors.mutedForeground, textWrap: "balance" },
  // What Grasp does now: the one dark thing on the canvas, as a tooltip is, its tail down.
  thought: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: `calc(2.5 * ${space["1"]})`,
    width: "max-content",
    maxWidth: "var(--caption)",
    paddingBlock: `calc(2.5 * ${space["1"]})`,
    paddingInline: space["4"],
    borderRadius: radii.base,
    backgroundColor: colors.foreground,
    color: colors.background,
    boxShadow: shadow.md,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    textAlign: "center",
    translate: "-50% -50%",
  },
  tail: {
    position: "absolute",
    insetBlockEnd: -4,
    insetInlineStart: "50%",
    width: 10,
    height: 10,
    borderRadius: 2,
    backgroundColor: colors.foreground,
    transform: "translateX(-50%) rotate(45deg)",
  },
  thoughtWords: { textWrap: "balance" },
});

/** What the drawing reads each frame. */
interface Latest {
  thought: Thought | undefined;
  map: ThinkingMap | null;
  room: { x: number; y: number; width: number; height: number };
  hovered: number;
  still: boolean;
  choose: (at: number) => void;
}

/** What a neuron's name says: what was said, its shared words underlined and who said it; a workflow, with its hours a week once weighed; or its name. */
const NameWords = ({ neuron }: { neuron: ThinkingNeuron }) => {
  if (neuron.hours !== undefined) {
    return (
      <span {...stylex.props(styles.column)}>
        <span {...stylex.props(styles.clamp, styles.clampTwo)}>
          {neuron.label}
        </span>
        <WorkHours hours={neuron.hours} />
      </span>
    );
  }
  if (neuron.by === undefined) {
    return neuron.label;
  }
  return (
    <>
      <span {...stylex.props(styles.clamp, styles.clampFour, styles.saidWords)}>
        {markShared(neuron.label, neuron.marks ?? []).map((piece, index) =>
          piece.shared ? (
            <span key={index} {...stylex.props(styles.shared)}>
              {piece.text}
            </span>
          ) : (
            piece.text
          )
        )}
      </span>
      <span {...stylex.props(styles.clamp, styles.clampTwo, styles.by)}>
        {neuron.by}
      </span>
    </>
  );
};

/** A neuron's name under it, ink on the canvas with nothing round it: what was said, its shared words underlined and who said it; or its name. */
const Name = ({
  neuron,
  at,
  up,
  small,
  keep,
  onPoint,
  onChoose,
}: {
  neuron: ThinkingNeuron;
  at: number;
  up: boolean;
  small: boolean;
  keep: (element: HTMLElement | null) => void;
  onPoint: (at: number) => void;
  onChoose: (at: number) => void;
}) => (
  <div
    {...stylex.props(styles.placed, stylex.defaultMarker(), up && styles.up)}
    data-quiet={neuron.quiet === true ? "true" : "false"}
    data-shown="false"
    ref={keep}
  >
    <button
      {...stylex.props(
        styles.name,
        neuron.by === undefined
          ? neuron.hours === undefined && [styles.clamp, styles.clampTwo]
          : styles.said,
        small && styles.small,
        neuron.state === "waiting" && styles.waiting,
        focusRing
      )}
      onClick={() => {
        onChoose(at);
      }}
      onPointerEnter={() => {
        onPoint(at);
      }}
      onPointerLeave={() => {
        onPoint(-1);
      }}
      title={neuron.title}
      type="button"
    >
      <NameWords neuron={neuron} />
    </button>
  </div>
);

/** What Grasp does now, as a tooltip is, its tail down to the shape: the one dark thing on the canvas; Grasp's working sign before it while it is at it. */
const ThoughtLine = ({ text, going }: { text: string; going: boolean }) => (
  <output {...stylex.props(styles.thought)}>
    <span aria-hidden="true" {...stylex.props(styles.tail)} />
    {going ? <Spinner /> : null}
    <span
      key={text}
      {...stylex.props(
        styles.clamp,
        styles.clampTwo,
        styles.thoughtWords,
        fadeIn
      )}
    >
      {text}
    </span>
  </output>
);

/** Watches an element's size; the way to stop watching. */
const watchSize = (
  element: HTMLElement,
  setSize: (size: Screen) => void
): (() => void) => {
  const observer = new ResizeObserver(([entry]) => {
    if (entry !== undefined) {
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    }
  });
  observer.observe(element);
  return () => {
    observer.disconnect();
  };
};

/** The size of an element, as it changes. */
const useSize = (box: RefObject<HTMLElement | null>): Screen => {
  const [size, setSize] = useState<Screen>({ width: 0, height: 0 });
  useEffect(() => {
    const element = box.current;
    return element === null ? undefined : watchSize(element, setSize);
  }, [box]);
  return size;
};

/** Where the pointer is over a soma, by its place; -1 for none. */
const somaAt = (
  seen: readonly { x: number; y: number; r: number }[],
  x: number,
  y: number
): number => {
  let best = -1;
  let nearest = Number.POSITIVE_INFINITY;
  for (const [at, each] of seen.entries()) {
    const d = Math.hypot(each.x - x, each.y - y);
    if (d < each.r + NEAR && d < nearest) {
      nearest = d;
      best = at;
    }
  }
  return best;
};

/** The names and the line where their neurons are: once the camera is at rest, the layout's own pixels. */
const placeWords = (
  state: Latest,
  live: ReadonlyMap<string, LiveNeuron>,
  names: ReadonlyMap<string, HTMLElement>,
  caption: HTMLElement | null,
  frame: {
    progress: number;
    ms: number;
    matrix: Float32Array;
    screen: Screen;
    plane: ReturnType<typeof planeOf>;
  }
): void => {
  const shape = state.map;
  if (shape === null) {
    return;
  }
  const ready = frame.progress >= SAYS_FROM;
  for (const [at, neuron] of shape.neurons.entries()) {
    const name = names.get(neuron.id);
    const each = live.get(neuron.id);
    if (name !== undefined && each !== undefined) {
      const x = neuron.say === undefined ? each.x : state.room.x + neuron.say.x;
      const y =
        neuron.say === undefined
          ? each.y + each.r + NAME.gap
          : state.room.y - neuron.say.y;
      name.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      const show = String(
        ready &&
          arrived(each, frame.ms) &&
          (name.dataset.quiet !== "true" || state.hovered === at)
      );
      if (name.dataset.shown !== show) {
        name.dataset.shown = show;
      }
    }
  }
  if (caption !== null) {
    const x = state.room.x + shape.caption.x;
    const y = state.room.y - shape.caption.y;
    const seen =
      frame.progress < 1
        ? project(onPlane(frame.plane, x, y), frame.matrix, frame.screen)
        : { x, y };
    caption.style.transform = `translate3d(${seen.x.toFixed(1)}px, ${seen.y.toFixed(1)}px, 0)`;
    const show = String(frame.progress >= CAPTION_FROM);
    if (caption.dataset.shown !== show) {
      caption.dataset.shown = show;
    }
  }
};

/** The refs the drawing reads and writes. */
interface DiveRefs {
  latest: RefObject<Latest>;
  names: RefObject<Map<string, HTMLElement>>;
  caption: RefObject<HTMLDivElement | null>;
  seenNow: RefObject<{ x: number; y: number; r: number }[]>;
}

/** The dive's clock: the last frame, when the camera set off from outside, when the thought went, and how sharp and slow frames are. */
interface Clock {
  raf: number;
  last: number;
  cameFrom: number;
  goneAt: number;
  sharpness: number;
  slow: number;
}

/** Whether a frame has anything to draw, the clock moved on for the thought now: coming in from outside, the camera flies (not on a 2D canvas, nor with less motion). */
const cameIn = (
  clock: Clock,
  state: Latest,
  flat: boolean,
  ms: number,
  live: Map<string, LiveNeuron>
): boolean => {
  if (state.thought === undefined) {
    if (clock.goneAt < 0 && clock.cameFrom >= 0) {
      clock.goneAt = ms;
    }
  } else {
    if (
      clock.cameFrom < 0 ||
      (clock.goneAt >= 0 && ms - clock.goneAt > DIVE.fade)
    ) {
      clock.cameFrom = state.still || flat ? ms - DIVE.flight : ms;
      live.clear();
    }
    clock.goneAt = -1;
  }
  return (
    clock.cameFrom >= 0 &&
    !(clock.goneAt >= 0 && ms - clock.goneAt > DIVE.fade + 60)
  );
};

/** What stands out: what the beat names, warm, the rest stepping back; or what the step lights. */
const litOf = (
  thought: Thought | undefined
): { lit: ReadonlySet<string>; named: boolean } => {
  const beatLit = thought?.beat?.lit ?? [];
  return beatLit.length > 0
    ? { lit: new Set(beatLit), named: true }
    : { lit: new Set(thought?.figure.lit), named: false };
};

/** How far the camera is on its flight in, 0 to 1. */
const flightAt = (clock: Clock, ms: number): number =>
  Math.min(1, (ms - clock.cameFrom) / DIVE.flight);

/** The canvas at the resolution frames allow: stepped down a little when they come slowly. */
const fitCanvas = (
  element: HTMLCanvasElement,
  clock: Clock,
  since: number
): void => {
  clock.slow = since > 1 / 40 ? clock.slow + 1 : Math.max(0, clock.slow - 1);
  if (clock.slow > 45 && clock.sharpness > 1) {
    clock.sharpness = Math.max(1, clock.sharpness - 0.5);
    clock.slow = 0;
  }
  const wide = Math.round(element.clientWidth * clock.sharpness);
  const high = Math.round(element.clientHeight * clock.sharpness);
  if (element.width !== wide || element.height !== high) {
    element.width = wide;
    element.height = high;
  }
};

/** The print of a frame, put into the painter's dots: every neuron, and the threads; how many dots. */
const printFrame = (
  dots: Float32Array,
  live: ReadonlyMap<string, LiveNeuron>,
  shape: ThinkingMap,
  thought: Thought | undefined,
  look: { step: number; growing: number; still: boolean; ms: number }
): number => {
  let used = 0;
  const put = (
    x: number,
    y: number,
    radius: number,
    alpha: number,
    heat: number,
    tone: number
  ): void => {
    if (used < MOST_DOTS && alpha >= 0.01) {
      dots.set([x, y, radius, alpha, heat, tone], used * DOT_FLOATS);
      used += 1;
    }
  };
  for (const each of live.values()) {
    printLive(each, look.step, look.growing, look.still, look.ms / 1000, put);
  }
  if (thought !== undefined) {
    printThreads(
      shape,
      thought,
      live,
      look.step,
      look.growing,
      Date.now(),
      look.still,
      put
    );
  }
  return used;
};

/**
 * Starts the dive's drawing on a canvas in its holder: a frame each
 * animation frame while there is a thought, or while the last one fades;
 * the pointer over a soma names it, a click opens it. The way to stop it.
 */
const startDive = (
  element: HTMLCanvasElement,
  holder: HTMLElement,
  refs: DiveRefs,
  onHover: (at: number) => void
): (() => void) => {
  const painter = makePainter(element, holder);
  const live = new Map<string, LiveNeuron>();
  const clock: Clock = {
    raf: 0,
    last: -1,
    cameFrom: -1,
    goneAt: -1,
    sharpness: Math.min(window.devicePixelRatio || 1, 2),
    slow: 0,
  };
  let plane = planeOf({ width: 0, height: 0 });
  let laidFor = "";
  let laidMap: ThinkingMap | null = null;

  const draw = (ms: number): void => {
    clock.raf = requestAnimationFrame(draw);
    const since =
      clock.last < 0 ? 1 / 60 : Math.min((ms - clock.last) / 1000, 0.1);
    clock.last = ms;
    const state = refs.latest.current;
    const shape = state.map;
    const screen = { width: element.clientWidth, height: element.clientHeight };
    if (
      !cameIn(clock, state, painter.flat, ms, live) ||
      screen.width === 0 ||
      screen.height === 0 ||
      shape === null
    ) {
      return;
    }
    laidFor = live.size === 0 ? "" : laidFor;
    fitCanvas(element, clock, since);
    // As finely as the atlas prints a region, so a neuron in the dive is as fine as in its region.
    const step =
      CLOUD_PITCH *
      FINE *
      Math.min(2 * state.room.x, (state.room.height + 32) * TALL) *
      FILL;
    const layout = `${screen.width}x${screen.height}:${state.room.x}:${state.room.y}`;
    if (laidMap !== shape || laidFor !== layout) {
      layOut(live, shape.neurons, state.room, step, ms, laidMap !== shape);
      laidMap = shape;
      laidFor = layout;
    }
    const { lit, named } = litOf(state.thought);
    settle(live, shape.neurons, lit, named, since, ms, state.still);
    const progress = state.still || painter.flat ? 1 : flightAt(clock, ms);
    const flying = flightPose(progress, screen.width / screen.height);
    const pose: Pose = progress < 1 ? flying : REST;
    const matrix = viewProjection(pose, screen);
    if (plane.width !== screen.width || plane.height !== screen.height) {
      plane = planeOf(screen);
    }
    const used = printFrame(painter.dots, live, shape, state.thought, {
      step,
      growing: smooth(SHAPE_FROM, 0.95, progress),
      still: state.still,
      ms,
    });
    painter.paint({
      matrix,
      pose,
      inside: progress >= 1 ? 1 : flying.inside,
      plane,
      dots: used,
    });
    refs.seenNow.current = shape.neurons.map((neuron) => {
      const each = live.get(neuron.id);
      return each === undefined
        ? { x: -999, y: -999, r: 0 }
        : { x: each.x, y: each.y, r: each.r };
    });
    placeWords(state, live, refs.names.current, refs.caption.current, {
      progress,
      ms,
      matrix,
      screen,
      plane,
    });
  };
  clock.raf = requestAnimationFrame(draw);

  const overAt = (event: MouseEvent): number => {
    const bounds = holder.getBoundingClientRect();
    return somaAt(
      refs.seenNow.current,
      event.clientX - bounds.left,
      event.clientY - bounds.top
    );
  };
  const onMove = (event: PointerEvent): void => {
    const at = overAt(event);
    if (at !== refs.latest.current.hovered) {
      onHover(at);
    }
  };
  const onLeave = (): void => {
    onHover(-1);
  };
  const onClick = (event: MouseEvent): void => {
    if (
      event.target instanceof Element &&
      event.target.closest("button") !== null
    ) {
      return;
    }
    const at = overAt(event);
    if (at >= 0) {
      refs.latest.current.choose(at);
    }
  };
  holder.addEventListener("pointermove", onMove);
  holder.addEventListener("pointerleave", onLeave);
  holder.addEventListener("click", onClick);
  return () => {
    cancelAnimationFrame(clock.raf);
    holder.removeEventListener("pointermove", onMove);
    holder.removeEventListener("pointerleave", onLeave);
    holder.removeEventListener("click", onClick);
    painter.dispose();
  };
};

/**
 * The dive over the brain: Grasp's thinking now (`thought`), what it keeps
 * clear, and what a neuron asked for opens (its note, or the source what
 * was said came from). `still` for less motion.
 */
export const ThinkingDive = ({
  thought,
  clear,
  still,
  onOpen,
}: {
  thought: Thought | undefined;
  clear: DiveClear;
  still: boolean;
  onOpen: (noteId: string) => void;
}) => {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const caption = useRef<HTMLDivElement>(null);
  const names = useRef(new Map<string, HTMLElement>());
  const seenNow = useRef<{ x: number; y: number; r: number }[]>([]);
  const size = useSize(box);
  const [hovered, setHovered] = useState(-1);
  // The thought shown last stays while the dive fades, so the shape fades with it.
  const [last, setLast] = useState(thought);
  if (thought !== undefined && thought !== last) {
    setLast(thought);
  }
  const shown = thought ?? last;
  const room = roomOf(size, clear);
  const map =
    shown !== undefined && room.width > 0
      ? thinkingMap(shown.figure, { width: room.width, height: room.height })
      : null;
  const choose = (at: number): void => {
    const noteId = map?.neurons[at]?.noteIds[0];
    if (noteId !== undefined) {
      onOpen(noteId);
    }
  };
  const latest = useRef<Latest>({ thought, map, room, hovered, still, choose });
  useEffect(() => {
    latest.current = { thought, map, room, hovered, still, choose };
  });
  useEffect(() => {
    const element = canvas.current;
    const holder = box.current;
    return element === null || holder === null
      ? undefined
      : startDive(
          element,
          holder,
          { latest, names, caption, seenNow },
          setHovered
        );
  }, []);
  const widest = map === null ? 128 : Math.floor(nameWidth(map.names.width));
  useLayoutEffect(() => {
    box.current?.style.setProperty("--cell", `${widest}px`);
    box.current?.style.setProperty(
      "--caption",
      `${Math.round(map?.caption.width ?? 320)}px`
    );
    box.current?.style.setProperty(
      "--said",
      `${Math.round(map?.said ?? 240)}px`
    );
  });
  const keep =
    (id: string) =>
    (element: HTMLElement | null): void => {
      if (element === null) {
        names.current.delete(id);
      } else {
        names.current.set(id, element);
      }
    };
  return (
    <div
      {...stylex.props(styles.dive, hovered >= 0 && styles.pointing)}
      data-shown={thought === undefined ? "false" : "true"}
      ref={box}
    >
      <canvas
        aria-hidden="true"
        ref={canvas}
        {...stylex.props(styles.canvas)}
      />
      {map?.neurons.map((neuron, at) => (
        <Name
          at={at}
          keep={keep(neuron.id)}
          key={neuron.id}
          neuron={neuron}
          onChoose={choose}
          onPoint={setHovered}
          small={map.names.small}
          up={hovered === at}
        />
      ))}
      {map === null || shown === undefined ? null : (
        <div
          {...stylex.props(styles.placed, styles.up)}
          data-shown="false"
          ref={caption}
        >
          <ThoughtLine going={shown.going} text={shown.text} />
        </div>
      )}
    </div>
  );
};
