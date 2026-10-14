import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import { ArrowUpRightIcon } from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode, Ref, RefObject } from "react";

import { MINI, runAtlas } from "./atlas-engine.ts";
import type {
  AtlasControls,
  AtlasFrame,
  AtlasLive,
  AtlasView,
  Over,
  Target,
} from "./atlas-engine.ts";
import {
  brainDots,
  brainMarks,
  clusterFolder,
  exitRows,
  facingTurn,
  KNOWN,
  MAP_ROOM,
  mapDots,
  mapMarks,
  nameWidth,
  neuronMap,
  OPEN_MARK,
  REGION_ZOOM,
  regionInView,
  WAITING,
} from "./atlas-map.ts";
import type { AtlasDots, Exit, Neuron, NeuronMap } from "./atlas-map.ts";
import { REGION_IDS, REGIONS } from "./brain-atlas.ts";
import type { Atlas, RegionId } from "./brain-atlas.ts";
import type { Brain } from "./brain.ts";
import type { BrainDots } from "./dot-ink.ts";
import { useLessMotion } from "./less-motion.ts";
import { RegionMarks } from "./region-marks.tsx";

export type { AtlasControls, AtlasView } from "./atlas-engine.ts";

/** Space kept clear over the canvas, in pixels. */
export interface AtlasClear {
  /** Along its top, and as much along its sides. */
  top: number;
  /** Along its bottom, for the chat's bar. */
  bottom: number;
  /** At the right, for the chat when it is open as a drawer. */
  right: number;
  /** Its top left corner, for the legend: how wide, and how high seen whole and in a region, where the small brain sits over it. */
  corner: { width: number; whole: number; region: number };
}

/** Pixels per world unit at zoom 1, as a share of the canvas's width, or of the height the brain has from its top to the end of its stem. */
const FILL = 0.33;
const TALL = 1.34;
/** What is kept clear never takes more than this share of the height from the brain. */
const CLEAR_MOST = 0.4;
/** How far the brain and the names around it reach from its middle, as a share of its scale: on a canvas too narrow to hold that beside the legend, the brain sits under it. */
const WHOLE_REACH = 1.45;
/** The chat as a drawer takes its width from the canvas only where that leaves the brain this much; on a narrower canvas it lies over the brain. */
const BESIDE_DRAWER = 300;
/** A way out's name: how high it is, how far apart two rows of them sit, the room between two in a row, and about how wide one is until it is measured. */
const PILL = { height: 30, row: 36, gap: 8, around: 58, letter: 7.6 };
/** The room between the ways out and the neurons under them, where the fibres gather; and the room under the legend, or beside the ways out, when the map lies below it. */
const GATHER = 40;
const UNDER = 16;
/** A map lies under the legend rather than beside it only when that makes its neurons this much larger. */
const BELOW_BY = 1.12;
/** A map's room is taken in steps of this many pixels, so a small resize does not lay it out anew. */
const STEP = 16;

/** A room on the canvas, in whole steps, in the middle of what there is. */
interface Room {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the ways out of a region sit, pinned over the canvas, and the rooms its neurons could have: beside the legend and under it. */
const placesOf = ({
  widths,
  wide,
  height,
  clear,
}: {
  widths: number[];
  wide: number;
  height: number;
  clear: AtlasClear;
}): {
  pins: { x: number; y: number }[];
  widest: number;
  beside: Room | null;
  below: Room;
} => {
  const { corner } = clear;
  const edge = clear.top;
  const to = wide - edge;
  // Beside the small brain, level with its middle, where their names fit there; under the legend where the canvas is too narrow for that.
  const beside = to - corner.width >= Math.min(Math.max(0, ...widths), 200);
  const from = beside ? corner.width : edge;
  const rows = exitRows(widths, to - from, PILL.gap);
  const first = beside
    ? Math.max(
        MINI.y - ((rows.length - 1) * PILL.row) / 2,
        edge + PILL.height / 2
      )
    : corner.region + PILL.height / 2;
  const pins = widths.map(() => ({ x: 0, y: 0 }));
  for (const [row, indexes] of rows.entries()) {
    const total =
      indexes.reduce((sum, index) => sum + (widths[index] ?? 0), 0) +
      (indexes.length - 1) * PILL.gap;
    let x = Math.max(from, (from + to) / 2 - total / 2);
    for (const index of indexes) {
      const width = widths[index] ?? 0;
      pins[index] = { x: x + width / 2, y: first + row * PILL.row };
      x += width + PILL.gap;
    }
  }
  const pillsBottom =
    rows.length > 0
      ? first + (rows.length - 1) * PILL.row + PILL.height / 2
      : edge;
  const bottom = height - clear.bottom;
  const room = (left: number, over: number): Room => {
    const width = Math.max(to - left, STEP);
    const tall = Math.max(bottom - over, STEP);
    // The room in whole steps, in the middle of what there is.
    return {
      x: left + width / 2,
      y: over + tall / 2,
      width: Math.floor(width / STEP) * STEP,
      height: Math.floor(tall / STEP) * STEP,
    };
  };
  return {
    pins,
    widest: Math.max(to - from, PILL.around),
    // Beside the legend, under the ways out; or under the legend, the whole canvas wide.
    beside: beside
      ? room(corner.width, pillsBottom + (rows.length > 0 ? GATHER : 0))
      : null,
    below: room(
      edge,
      Math.max(corner.region + UNDER, pillsBottom + (beside ? UNDER : GATHER))
    ),
  };
};

/** The map in each room, and the one that serves the region best: the one that shows more of it, then the one that cuts less of its names, then the one with the larger neurons; beside the legend when they are as good. */
const bestMap = (
  below: NeuronMap,
  aside: NeuronMap | null
): { below: boolean; map: NeuronMap } => {
  if (!aside) {
    return { below: true, map: below };
  }
  const better =
    Number(below.fits) - Number(aside.fits) ||
    below.neurons.length - aside.neurons.length ||
    aside.cell.short - below.cell.short ||
    below.cell.soma - aside.cell.soma * BELOW_BY;
  return better > 0
    ? { below: true, map: below }
    : { below: false, map: aside };
};

/** The mark the legend points at, as the drawing knows it. */
const spottedOf = (spot: "known" | "waiting" | "open" | undefined): number => {
  if (spot === "known") {
    return KNOWN;
  }
  if (spot === "waiting") {
    return WAITING;
  }
  return spot === "open" ? OPEN_MARK : -1;
};

/** Balanced where a name has the lines to end on; where it may be cut short it fills its lines instead, so as much of it as fits is read. */
const linesClass = (lines: number | undefined): string => {
  if (lines === 1) {
    return "line-clamp-1";
  }
  return lines === 2 ? "line-clamp-2" : "line-clamp-3 text-balance";
};

/** A neuron's name as it stands: in hand, an open question, a note still waiting, or a known one. */
const neuronClass = (chosen: boolean, state: Neuron["state"]): string => {
  if (chosen) {
    return "border-foreground bg-foreground font-medium text-background";
  }
  if (state === "open") {
    return "bg-card font-medium text-status-attention";
  }
  return state === "waiting"
    ? "bg-card text-muted-foreground"
    : "bg-card font-medium";
};

// Hidden, a name can't be pointed at or reached with Tab: it goes invisible once it has faded.
const PLACE =
  "pointer-events-none absolute top-0 left-0 fade-shown data-[shown=false]:invisible data-[shown=false]:opacity-0";

/** The brain's dots, made once and kept: every atlas on screen draws from them. */
let cloudOnce: AtlasDots | null = null;

const atlasCloud = (): AtlasDots => {
  cloudOnce ??= brainDots();
  return cloudOnce;
};

/** What the brain holds, in short: a figure is drawn anew when this changes, as when a question is answered. */
const holdsOf = (atlas: Atlas): string =>
  `${atlas.open.map((item) => item.id).join(",")}|${atlas.regions.map((region) => `${region.notes.length}:${region.waiting.length}`).join(",")}`;

/**
 * Seen whole: the room the brain has (the canvas, less the chat when it is a drawer beside it),
 * the scale, and where the brain is centred, between what is kept clear above and below. On a
 * canvas too narrow to hold it beside the legend, it starts under the legend.
 */
const wholeOf = (
  size: { width: number; height: number },
  clear: AtlasClear
): { wide: number; level: number; scale: number } => {
  const besideDrawer = size.width - clear.right >= BESIDE_DRAWER;
  const wide = Math.max(size.width - (besideDrawer ? clear.right : 0), 1);
  const share = (top: number) =>
    Math.min((size.height * CLEAR_MOST) / Math.max(top + clear.bottom, 1), 1);
  const openHeight = Math.max(
    size.height - (clear.top + clear.bottom) * share(clear.top),
    1
  );
  const lowered =
    wide / 2 - Math.min(wide, openHeight * TALL) * FILL * WHOLE_REACH <
    clear.corner.width;
  const top = lowered ? clear.corner.whole : clear.top;
  const freeHeight = Math.max(
    size.height - (top + clear.bottom) * share(top),
    1
  );
  return {
    wide,
    level: top * share(top) + freeHeight / 2,
    scale: Math.min(wide, freeHeight * TALL) * FILL,
  };
};

/** About how wide a way out's name is, until it is measured. */
const guessedWidths = (ways: Exit[]): string =>
  ways
    .map((way) =>
      Math.round(
        PILL.around +
          PILL.letter * (way.region.length + String(way.count).length)
      )
    )
    .join(",");

/** The region laid out in the room that serves it best, beside the legend or under it; none seen whole, or before the canvas has a size. */
const layOut = ({
  view,
  atlas,
  brain,
  width,
  places,
}: {
  view: AtlasView;
  atlas: Atlas;
  brain: Brain;
  width: number;
  places: ReturnType<typeof placesOf>;
}): { below: boolean; map: NeuronMap } | null => {
  const { region } = view;
  if (region === undefined || width === 0) {
    return null;
  }
  const { below, beside } = places;
  const aside =
    beside && beside.width > 0
      ? neuronMap(
          region,
          atlas,
          brain,
          { width: beside.width, height: beside.height },
          view.group
        )
      : null;
  return bestMap(
    neuronMap(
      region,
      atlas,
      brain,
      { width: below.width, height: below.height },
      view.group
    ),
    aside
  );
};

/** Where a region's map opens: where the region is once turned to face you. A map is laid out in pixels, which the camera shows one to one. */
const frameOf = (
  region: RegionId | undefined,
  scale: number
): AtlasFrame | null => {
  if (region === undefined) {
    return null;
  }
  const index = REGION_IDS.indexOf(region);
  const middle = regionInView(index);
  return {
    x: middle.x,
    y: middle.y,
    reach: 1 / (scale * REGION_ZOOM),
    zoom: REGION_ZOOM,
    turn: facingTurn(index),
  };
};

/** The map as shown: its ways out pinned where their names are, whatever room the map has, in the map's own pixels from its middle. */
const pinned = (
  map: NeuronMap,
  pins: { x: number; y: number }[],
  centre: number,
  level: number
): NeuronMap => ({
  ...map,
  exits: map.exits.map((exit, index) => ({
    ...exit,
    x: (pins[index]?.x ?? centre) - centre,
    y: level - (pins[index]?.y ?? level),
  })),
});

/** A map as dots, and the key that says when it must be drawn anew. */
const mapTargetOf = (
  map: NeuronMap,
  frame: AtlasFrame,
  group: string | undefined,
  holds: string
): Target => {
  const dots = mapDots(map, frame);
  const outs = map.exits
    .map((exit) => `${Math.round(exit.x)},${Math.round(exit.y)}`)
    .join(" ");
  return {
    key: `map:${map.region}:${group ?? ""}:${map.room.width}x${map.room.height}:${map.neurons.length}:${Math.round(frame.reach * 1e6)}:${outs}:${holds}`,
    turning: false,
    dots,
    marks: mapMarks(dots, map),
  };
};

/** Which neuron is a note's: the note itself, or the folder that holds it. -1 for none. */
const neuronOf = (map: NeuronMap | null, note: string | undefined): number =>
  map && note !== undefined
    ? map.neurons.findIndex(
        (neuron) => neuron.id === note || neuron.noteIds.includes(note)
      )
    : -1;

/** The neuron of the note the camera goes in on. -1 for none. */
const divingInto = (map: NeuronMap | null, dive: string | undefined): number =>
  map && dive !== undefined
    ? map.neurons.findIndex(
        (neuron) => neuron.kind !== "cluster" && neuron.noteIds[0] === dive
      )
    : -1;

/** The neurons that hold a lit note. */
const litNeuronsOf = (map: NeuronMap | null, lit: string[]): number[] =>
  map
    ? map.neurons.flatMap((neuron, index) =>
        neuron.noteIds.some((id) => lit.includes(id)) ? [index] : []
      )
    : [];

/** Seen whole, the parts of the brain that hold what is lit. */
const litRegionsOf = (atlas: Atlas, lit: string[]): Set<number> =>
  new Set(
    lit.flatMap((id) => {
      const home = atlas.home.get(id);
      return home === undefined ? [] : [REGION_IDS.indexOf(home)];
    })
  );

/** What the pointer is over: a name wins, as it lies on top. */
const hoveredOf = (named: Over, under: Over): Over =>
  named.region !== undefined ||
  named.neuron !== undefined ||
  named.exit !== undefined
    ? named
    : under;

/** Follows the size an element is shown at; the function it gives back stops. */
const watchSize = (
  element: HTMLElement,
  setSize: (size: { width: number; height: number }) => void
): (() => void) => {
  const observer = new ResizeObserver(([entry]) => {
    if (entry) {
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

/** Measures the ways out's names, now and whenever one changes size; the function it gives back stops. */
const watchPills = (
  pills: Element[],
  key: string,
  setMeasured: (
    next: (before: { key: string; widths: string }) => {
      key: string;
      widths: string;
    }
  ) => void
): (() => void) => {
  const measure = () => {
    const widths = pills
      .map((pill) => Math.ceil(pill.getBoundingClientRect().width))
      .join(",");
    setMeasured((before) =>
      before.key === key && before.widths === widths ? before : { key, widths }
    );
  };
  measure();
  const observer = new ResizeObserver(measure);
  for (const pill of pills) {
    observer.observe(pill);
  }
  return () => {
    observer.disconnect();
  };
};

/** How large the canvas is shown, as it changes. */
const useSize = (box: RefObject<HTMLDivElement | null>) => {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = box.current;
    return element ? watchSize(element, setSize) : undefined;
  }, [box]);
  return size;
};

/** How wide each way out's name is on screen, measured before it shows; about as wide until it is. Measured again when a font arrives or the language changes what a name says. */
const usePillWidths = (
  ways: Exit[],
  waysKey: string,
  overlays: RefObject<Map<string, HTMLElement>>
): string => {
  const [measured, setMeasured] = useState({ key: "", widths: "" });
  const many = ways.length;
  useLayoutEffect(() => {
    const pills = Array.from(
      { length: many },
      (_, index) =>
        overlays.current.get(`exit:${index}`)?.firstElementChild ?? null
    ).filter((pill) => pill !== null);
    return pills.length === 0
      ? undefined
      : watchPills(pills, waysKey, setMeasured);
  }, [many, waysKey, overlays]);
  return measured.key === waysKey ? measured.widths : guessedWidths(ways);
};

/** A ref for a name over the canvas, so the drawing can place it: by its id. */
type Keep = (id: string) => (element: HTMLElement | null) => void;

/** Region names on the brain: buttons, so the keys go in too. A name keeps its size; what the region holds shows on a card under it while it is lifted, one line per mark. */
const RegionNames = ({
  atlas,
  lifted,
  keep,
  onName,
  onGo,
}: {
  atlas: Atlas;
  lifted: RegionId | undefined;
  keep: Keep;
  onName: (over: Over) => void;
  onGo: (view: AtlasView) => void;
}) => {
  const { i18n } = useLingui();
  return atlas.regions.map((region) => {
    const up = lifted === region.id;
    return (
      <div
        className={cn(PLACE, up && "z-10")}
        data-shown="false"
        key={region.id}
        ref={keep(`region:${region.id}`)}
      >
        <button
          className={cn(
            "bg-card focus-visible:ring-ring/50 pointer-events-auto flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-lg border px-2.5 py-1 font-medium whitespace-nowrap shadow-xs transition-shadow outline-none focus-visible:ring-3",
            up && "shadow-md"
          )}
          onBlur={() => {
            onName({});
          }}
          onClick={() => {
            onGo({ region: region.id });
          }}
          onFocus={() => {
            onName({ region: region.id });
          }}
          onPointerEnter={() => {
            onName({ region: region.id });
          }}
          onPointerLeave={() => {
            onName({});
          }}
          type="button"
        >
          {i18n._(region.label)}
          {region.open.length > 0 ? (
            <span className="bg-status-attention text-primary-foreground rounded-full px-1.5 text-xs tabular-nums">
              {region.open.length}
            </span>
          ) : null}
        </button>
        {up ? (
          <RegionMarks
            className="bg-popover absolute top-5 left-0 -translate-x-1/2 rounded-md border px-2.5 py-2 whitespace-nowrap shadow-md"
            region={region}
          />
        ) : null}
      </div>
    );
  });
};

/** A folder's name over its neurons, when it has several: one neuron says what it is itself. A folder with a note of its own opens it. Left out when the region is one folder. */
const GroupNames = ({
  map,
  keep,
  onOpen,
}: {
  map: NeuronMap;
  keep: Keep;
  onOpen: (noteId: string) => void;
}) =>
  map.groups.map((group, index) => {
    if (group.lines === 0) {
      return null;
    }
    const own = group.noteId;
    return (
      <div
        className={PLACE}
        data-shown="false"
        key={`${map.region}:group:${group.label}`}
        ref={keep(`group:${index}`)}
      >
        {/* Over its neurons, growing upwards when its name takes two lines in a narrow group. */}
        <p className="text-muted-foreground pointer-events-auto line-clamp-2 max-w-(--wide) -translate-y-full text-xs leading-tight font-medium text-balance">
          {own === undefined ? (
            group.label
          ) : (
            <button
              className="hover:text-foreground focus-visible:ring-ring/50 rounded-sm text-left outline-none hover:underline focus-visible:ring-3"
              onClick={() => {
                onOpen(own);
              }}
              type="button"
            >
              {group.label}
            </button>
          )}
        </p>
      </div>
    );
  });

/** A region's neurons named under them. An open question beside what it is about says what it asks when pointed at; among the gaps, always. */
const NeuronNames = ({
  map,
  chosen,
  hovered,
  keep,
  onName,
  onChoose,
}: {
  map: NeuronMap;
  chosen: number;
  hovered: number | undefined;
  keep: Keep;
  onName: (over: Over) => void;
  onChoose: (index: number) => void;
}) => {
  // No name takes more lines than its cell is high for; a full region names its notes a size smaller.
  const lines = linesClass(map.cell.lines);
  return map.neurons.map((neuron, index) => {
    const question = neuron.kind === "gap";
    const quiet = question && map.region !== "gaps";
    const up = chosen === index || hovered === index;
    return (
      <div
        className={cn(PLACE, up && "z-10")}
        data-quiet={quiet ? "true" : "false"}
        data-shown="false"
        key={`${map.region}:${neuron.id}`}
        ref={keep(`neuron:${index}`)}
      >
        <button
          className={cn(
            "focus-visible:ring-ring/50 pointer-events-auto max-w-(--cell) -translate-x-1/2 rounded-md border px-1 py-0.5 text-center leading-tight shadow-xs outline-none focus-visible:ring-3",
            // An open question says what it asks in full; a note's name keeps to the lines its cell has.
            question ? "line-clamp-3 text-balance" : lines,
            map.cell.small && "text-xs",
            question && "max-w-56 text-xs",
            neuronClass(chosen === index, neuron.state),
            up && chosen !== index && "border-foreground/40 shadow-md"
          )}
          onClick={() => {
            onChoose(index);
          }}
          onPointerEnter={() => {
            onName({ neuron: index });
          }}
          onPointerLeave={() => {
            onName({});
          }}
          title={neuron.title}
          type="button"
        >
          {neuron.label}
        </button>
      </div>
    );
  });
};

/** The ways out, pinned along the top, level with the small brain: every other region this one links to, in as many rows as the canvas needs for them to stand apart. Pointing shows which notes take it; a click follows them there. */
const WayOuts = ({
  region,
  ways,
  litRegions,
  keep,
  onName,
  onGo,
}: {
  region: RegionId;
  ways: Exit[];
  litRegions: Set<number>;
  keep: Keep;
  onName: (over: Over) => void;
  onGo: (view: AtlasView) => void;
}) => {
  const { i18n } = useLingui();
  return ways.map((exit, index) => {
    const to = REGIONS.find((each) => each.id === exit.region);
    return (
      <div
        className={PLACE}
        data-shown="false"
        key={`${region}:exit:${exit.region}`}
        ref={keep(`exit:${index}`)}
      >
        <button
          className={cn(
            "bg-card hover:bg-muted focus-visible:ring-ring/50 pointer-events-auto flex max-w-(--pill) -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full border py-1 pr-3 pl-2 font-medium whitespace-nowrap shadow-xs transition-colors outline-none focus-visible:ring-3",
            // What is lit also lives there: an answer drew on that part.
            litRegions.has(REGION_IDS.indexOf(exit.region)) &&
              "border-foreground"
          )}
          onBlur={() => {
            onName({});
          }}
          onClick={() => {
            onGo({ region: exit.region });
          }}
          onFocus={() => {
            onName({ exit: index });
          }}
          onPointerEnter={() => {
            onName({ exit: index });
          }}
          onPointerLeave={() => {
            onName({});
          }}
          type="button"
        >
          <ArrowUpRightIcon className="text-muted-foreground size-3.5 flex-none" />
          <span className="truncate">
            {to ? i18n._(to.label) : exit.region}
          </span>
          <span className="text-muted-foreground font-normal tabular-nums">
            {exit.count}
          </span>
        </button>
      </div>
    );
  });
};

/** Nothing to ask of the camera before the drawing starts. */
const idle = () => {
  // The drawing hands over its own once it runs.
};

/**
 * The company brain in 3D, drawn in dots, to explore, as in the prototype (grasplabs/prototype,
 * packages/grasp: components/knowledge/brain-atlas.tsx); the drawing itself is atlas-engine.ts.
 * Seen whole it turns slowly either side of rest, and dragging turns it all the way round; its
 * dots are shaded by where the light falls as it turns, as in print, and the far side never shows
 * through; its stem runs on down as a spine. Clicking a region turns that part to face you, then
 * the camera goes in and its dots unfold into a slice of cortex: its notes as neurons, folder by
 * folder. Dots flow from one figure into the next, paired along a curve so the picture grows
 * rather than scrambles.
 *
 * A filled dot is something known, a hollow one is still waiting, the attention colour is a
 * question still open. Seen whole, it fires: each pulse is a statement running its own way, from
 * the source that heard it, up the spine, to the team, the tool and the workflow it is about, and
 * what is still unknown runs from the gaps to what it is about. In a region every link shows, so
 * its neurons read as connected; pointing brings one out: a note shows its own, a way out shows
 * every note that takes it. A region with several folders can be narrowed to one; a folder shown
 * as one neuron opens as that. Clicking a note goes in on its neuron and hands its dots over, to
 * build the note's page. A small brain says where you are, and goes elsewhere on a click.
 * Scrolling zooms around the pointer and, far enough out, goes back.
 *
 * Names are real buttons over the canvas, so the keys and screen readers get through too. With
 * less motion, nothing sways and figures change in place.
 */
export const BrainAtlas = ({
  atlas,
  brain,
  view,
  lit,
  thinking = false,
  signals,
  pointed,
  spot,
  clear,
  controls,
  dive,
  onGo,
  onOpen,
  onDived,
  onLaid,
  children,
}: {
  atlas: Atlas;
  brain: Brain;
  view: AtlasView;
  /** Notes lit now: the ones an answer drew on. Seen whole, the parts that hold them. */
  lit: string[];
  /** A question is being answered: it runs up the spine into the brain until the answer is there. */
  thinking?: boolean;
  /** The ways statements run through the brain, region by region: what it fires, seen whole. */
  signals: RegionId[][];
  /** A region the keys point at, lifted as if hovered. */
  pointed?: RegionId;
  /** The mark the legend points at: the dots that have it light up, the rest step back. */
  spot?: "known" | "waiting" | "open";
  clear: AtlasClear;
  /** Given what the zoom buttons can ask of the atlas. */
  controls?: Ref<AtlasControls>;
  /** The note the camera goes in on, before its page opens. */
  dive?: string;
  onGo: (view: AtlasView) => void;
  /** A note is asked for: its page, full screen. */
  onOpen: (noteId: string) => void;
  /** The camera is in on the note: its dots as they are on the canvas, to build the page from. */
  onDived: (dots: BrainDots) => void;
  /** A region is laid out in the room it has: its neurons as they are shown, a folder folded into one where the room is small. */
  onLaid?: (neurons: Neuron[]) => void;
  children?: ReactNode;
}) => {
  const { i18n } = useLingui();
  const reduce = useLessMotion();
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlays = useRef(new Map<string, HTMLElement>());
  // What the zoom buttons ask goes to the camera, which lives with the drawing.
  const camera = useRef<AtlasControls>({ zoom: idle, reset: idle });
  useImperativeHandle(
    controls,
    () => ({
      zoom: (factor) => {
        camera.current.zoom(factor);
      },
      reset: () => {
        camera.current.reset();
      },
    }),
    []
  );
  const size = useSize(box);
  // What the pointer is over on the canvas, and the name it is on.
  const [under, setUnder] = useState<Over>({});
  const [named, setNamed] = useState<Over>({});
  const hovered = hoveredOf(named, under);

  const cloud = atlasCloud();
  const holds = holdsOf(atlas);
  const brainTarget: Target = {
    key: `brain:${holds}`,
    turning: true,
    dots: cloud,
    marks: brainMarks(cloud, atlas),
  };
  const whole = wholeOf(size, clear);

  // The ways out of a region, which are the same in any room.
  const ways =
    view.region === undefined
      ? []
      : neuronMap(view.region, atlas, brain, MAP_ROOM, view.group).exits;
  const waysKey = `${view.region ?? ""}|${view.group ?? ""}|${i18n.locale}|${ways.map((way) => `${way.region}:${way.count}`).join(",")}`;
  const pillWidths = usePillWidths(ways, waysKey, overlays);

  // A region: where its ways out sit, pinned over the canvas, and the rooms its neurons could have, beside the legend and under it.
  const places = placesOf({
    widths: pillWidths === "" ? [] : pillWidths.split(",").map(Number),
    wide: whole.wide,
    height: size.height,
    clear,
  });
  const laid = layOut({ view, atlas, brain, width: size.width, places });
  const room =
    laid?.below === false && places.beside ? places.beside : places.below;
  // Where the picture is centred: the middle of the region's room, or seen whole, of the canvas.
  const centre = laid ? room.x : whole.wide / 2;
  const level = laid ? room.y : whole.level;
  const frame = frameOf(view.region, whole.scale);
  const { pins } = places;
  const map = laid ? pinned(laid.map, pins, centre, level) : null;
  const target =
    map && frame ? mapTargetOf(map, frame, view.group, holds) : brainTarget;

  // The note in focus, the one the camera goes in on, and the neurons and parts what is lit is in.
  const chosen = neuronOf(map, view.note);
  const litRegions = litRegionsOf(atlas, lit);

  // A neuron is asked for: an open question is looked at where it is, a folder narrows the region to it, a note (an answered question too) opens its page.
  const choose = (index: number) => {
    const neuron = map?.neurons[index];
    if (!(map && neuron)) {
      return;
    }
    const [noteId] = neuron.noteIds;
    if (neuron.kind === "cluster") {
      onGo({ region: map.region, group: clusterFolder(neuron.id) });
    } else if (neuron.kind === "gap" && neuron.state === "open") {
      onGo({ region: map.region, group: view.group, note: neuron.id });
    } else if (noteId !== undefined) {
      onOpen(noteId);
    }
  };

  const live: AtlasLive = {
    target,
    frame,
    map,
    pins,
    chosen,
    diving: divingInto(map, dive),
    litNeurons: litNeuronsOf(map, lit),
    litRegions,
    thinking,
    hovered,
    under,
    pointed,
    spotted: spottedOf(spot),
    reduce,
    level,
    centre,
    scale: whole.scale,
    onGo,
    onDived,
    choose,
    view,
    signals,
    // The small brain sits in the middle of the legend's corner, however wide that is.
    miniX: clear.corner.width / 2,
  };
  const latest = useRef(live);
  useEffect(() => {
    latest.current = live;
  });
  // The neurons as they are laid out here go to whoever steps through them, each time the layout changes.
  const laidOut = laid?.map.neurons;
  const lay = useRef(onLaid);
  useEffect(() => {
    lay.current = onLaid;
  });
  useEffect(() => {
    if (laidOut) {
      lay.current?.(laidOut);
    }
  }, [laidOut]);

  useEffect(() => {
    const element = canvas.current;
    const run = element
      ? runAtlas(element, atlasCloud(), latest, overlays.current, setUnder)
      : null;
    if (run) {
      camera.current = run.controls;
    }
    return run?.stop;
  }, [latest]);

  // No name is wider than the room its neuron has: set on the box, with the room the ways out have, and on each group's name, as the drawing places them.
  const widest = map ? Math.floor(nameWidth(map.cell.width)) : 128;
  const pillRoom = Math.round(places.widest);
  useLayoutEffect(() => {
    box.current?.style.setProperty("--cell", `${widest}px`);
    box.current?.style.setProperty("--pill", `${pillRoom}px`);
    for (const [index, group] of (map?.groups ?? []).entries()) {
      overlays.current
        .get(`group:${index}`)
        ?.style.setProperty("--wide", `${Math.round(group.width)}px`);
    }
  });

  const keep: Keep = (id) => (element) => {
    if (element) {
      overlays.current.set(id, element);
    } else {
      overlays.current.delete(id);
    }
  };

  return (
    <div
      className="bg-muted/30 relative min-h-0 flex-1 overflow-hidden text-sm"
      data-tour="brain"
      ref={box}
    >
      <canvas
        aria-hidden="true"
        className="absolute inset-0 size-full touch-none"
        ref={canvas}
      />
      {map ? (
        <>
          <GroupNames keep={keep} map={map} onOpen={onOpen} />
          <NeuronNames
            chosen={chosen}
            hovered={hovered.neuron}
            keep={keep}
            map={map}
            onChoose={choose}
            onName={setNamed}
          />
        </>
      ) : (
        <RegionNames
          atlas={atlas}
          keep={keep}
          lifted={hovered.region ?? pointed}
          onGo={onGo}
          onName={setNamed}
        />
      )}
      {view.region === undefined ? null : (
        <WayOuts
          keep={keep}
          litRegions={litRegions}
          onGo={onGo}
          onName={setNamed}
          region={view.region}
          ways={ways}
        />
      )}
      {children}
    </div>
  );
};
