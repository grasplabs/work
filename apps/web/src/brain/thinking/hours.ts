import type { Workspace } from "@grasp-os/shared/brain";
import { hoursPerWeek } from "@grasp-os/shared/thinking";
import type { ThinkingStep } from "@grasp-os/shared/thinking";

import type { MapRoom } from "../atlas-map.ts";
import type { Brain } from "../brain.ts";
import { BEAT, inTurn } from "./beats.ts";
import type { BeatSay, ThinkingBeat } from "./beats.ts";
import { CAPTION, NAME, PAIR_UNDER, PHONE, RING, TEAM_R } from "./layout.ts";
import type { ThinkingMap, ThinkingNeuron } from "./layout.ts";

// The shape of Grasp's thinking for where the hours go (grasplabs/
// prototype `lib/thinking-hours.ts`): the brain's workflows in a ring as
// Grasp reads them; then each grows to its hours a week, a warm thread
// from each to the one before as the hours add up, and what is not known
// yet steps down to a quiet row at the foot, small and hollow; then the
// ring lets go of all but the ones that take most of the hours, which come
// together on one row under the line. The hours are the brain's own
// (`hoursPerWeek`, as core tells the model), never the model's. Where a
// ring would crowd, as on a phone, the work stands in rows of three. Pure.

/** A workflow in the shape, with its hours a week. */
export interface FigureWork {
  /** The workflow's id. */
  id: string;
  /** The brain's note for it, when it has one: what pointing at it opens. */
  noteId?: string;
  name: string;
  /** Hours a week today; null while they are not known. */
  hours: number | null;
}

/** What the hours shape shows at a step. */
export interface HoursFigure {
  shape: "hours";
  move: "work" | "hours" | "most";
  /** How long the step's own sentence stays up before its first beat. */
  lead?: number;
  /** All the work looked at so far, in the brain's order. */
  works: FigureWork[];
  /** Once found: the ones that take most of the hours, in that order. */
  most: string[];
  /** What stands out now: the work the step looks at. */
  lit: string[];
}

const moves = new Set(["work", "hours", "most"]);
const isHoursMove = (move: string): move is HoursFigure["move"] =>
  moves.has(move);

/** The workflows the brain knows, each with its note and its hours a week. */
const workKnown = (ws: Workspace, brain: Brain): FigureWork[] => {
  const noted = new Set(brain.notes.map(({ id }) => id));
  return ws.workflows.map((workflow) => {
    const noteId = ws.candidates.find(
      (candidate) =>
        candidate.workflowId === workflow.id && noted.has(candidate.id)
    )?.id;
    return {
      id: workflow.id,
      ...(noteId === undefined ? {} : { noteId }),
      name: workflow.name,
      hours: hoursPerWeek(workflow),
    };
  });
};

/** The first step of the run of hours steps that `at` is in. */
const runStart = (steps: readonly ThinkingStep[], at: number): number => {
  let first = at;
  while (first > 0 && steps[first - 1]?.shape === "hours") {
    first -= 1;
  }
  return first;
};

/**
 * What the hours shape shows at step `at`: all the work its steps have
 * looked at so far, each with its hours a week. Nothing when there is no
 * work to show.
 */
export const hoursAt = (
  steps: readonly ThinkingStep[],
  at: number,
  ws: Workspace,
  brain: Brain
): HoursFigure | undefined => {
  const step = steps[at];
  if (step?.shape !== "hours" || !isHoursMove(step.move)) {
    return undefined;
  }
  const known = workKnown(ws, brain);
  const named = (ids: readonly string[]): FigureWork[] => {
    const asked = new Set(ids);
    return known.filter(({ id }) => asked.has(id));
  };
  const works = named(
    steps.slice(runStart(steps, at), at + 1).flatMap(({ notes }) => notes)
  );
  if (works.length === 0) {
    return undefined;
  }
  const here = named(step.notes).map(({ id }) => id);
  return {
    shape: "hours",
    move: step.move,
    works,
    most: step.move === "most" ? here : [],
    lit: here,
  };
};

/** Hours as they are said: to a tenth under ten, else whole. */
export const roundHours = (hours: number): number =>
  hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours);

const sumOf = (works: readonly FigureWork[]): number =>
  works.reduce((sum, each) => sum + (each.hours ?? 0), 0);

/** A beat for each workflow as Grasp adds it to the ones before: its hours, a thread from the one before, and what is lit, it alone or all added so far. */
const added = (
  works: readonly FigureWork[],
  cumulative: boolean
): Omit<ThinkingBeat, "at">[] => {
  // More than can be read out one by one: the line says how many it adds up, and the light walks along them.
  const many = works.length > BEAT.named;
  return works.map((each, at) => {
    const before = works[at - 1];
    const say: BeatSay = many
      ? { kind: "weighingAll", count: works.length }
      : { kind: "weighing", name: each.name, hours: each.hours ?? 0 };
    return {
      lit: cumulative ? works.slice(0, at + 1).map(({ id }) => id) : [each.id],
      ...(before === undefined
        ? {}
        : { thread: [before.id, each.id] satisfies [string, string] }),
      say,
    };
  });
};

/**
 * What the brain does, beat by beat, in a step of the hours, each line up
 * as long as it takes to read: reading each workflow in turn (a long list
 * under one line, the light walking along it); weighing each that has
 * hours, a thread from the one before as it adds them up, then how many
 * are not counted yet and the hours counted in all; and found, the ones
 * that take most adding up, and what share of all the hours they are.
 */
export const hoursBeats = (figure: HoursFigure): ThinkingBeat[] => {
  const known = figure.works.filter(({ hours }) => hours !== null);
  const all = sumOf(known);
  if (figure.move === "work") {
    const many = figure.works.length > BEAT.named;
    return inTurn(
      figure.works.map((each) => ({
        lit: [each.id],
        say: many
          ? { kind: "readingAll", count: figure.works.length }
          : { kind: "reading", name: each.name },
      })),
      figure.lead
    );
  }
  if (figure.move === "hours") {
    const beats = added(known, false);
    const unknown = figure.works.filter(({ hours }) => hours === null);
    if (unknown.length > 0) {
      beats.push({
        lit: unknown.map(({ id }) => id),
        say: { kind: "unknown", count: unknown.length },
      });
    }
    beats.push({
      lit: known.map(({ id }) => id),
      say: { kind: "total", hours: all },
    });
    return inTurn(beats, figure.lead);
  }
  const most = known.filter(({ id }) => figure.most.includes(id));
  const beats = added(most, true);
  if (most.length > 0) {
    beats.push({
      lit: most.map(({ id }) => id),
      say: { kind: "share", hours: sumOf(most), of: all },
    });
  }
  return inTurn(beats, figure.lead);
};

/** A workflow's soma: as large as a team's while Grasp reads it; weighed, its area grows with its hours, the most hours this many times a team's radius, the fewest no smaller than this; what is not known yet smaller still. */
const WORK_R = { most: 1.7, least: 0.5, unknown: 0.4 };
/** More work than this, and while Grasp reads it the names wait until pointed at: a ring of names that long is a list, not a picture. */
const NAMED_UP_TO = 9;
/** The ring grows with the work it holds, past the size a ring of teams has, by so many pixels across and up for each more. */
const RING_GROWS = { from: 6, across: 14, up: 8 };
/** Where the ring would put two workflows closer than this, as on a phone, they stand in rows instead (closer when their names wait to be pointed at): so many across, this far from the room's sides, the rows at most this far apart. */
export const GRID = {
  closest: 112,
  quiet: 64,
  across: 3,
  edge: 16,
  pitch: 170,
};
/** The work not known yet, at the foot: at most this far apart. */
const BENCH = { apart: 44 };
/** The finding fills the room under the line: the largest of it at most this large, at most this share of the room it has across, and the ones beside it at most this far apart. */
const FOUND = { most: 76, across: 0.26, apart: 320 };

interface Point {
  x: number;
  y: number;
}

/**
 * So many places on a ring as wide and high as this, evenly apart along
 * it, from the top left round the way a clock goes: evenly by angle they
 * would crowd where the ring turns most.
 */
export const ringPoints = (
  count: number,
  wide: number,
  high: number,
  middle: number
): Point[] => {
  if (count <= 1) {
    return count === 1 ? [{ x: 0, y: middle }] : [];
  }
  const start = Math.PI / 2 + Math.PI / count;
  const samples = 720;
  const at = (step: number): Point => {
    const angle = start - (step * 2 * Math.PI) / samples;
    return { x: wide * Math.cos(angle), y: middle + high * Math.sin(angle) };
  };
  const along = [0];
  for (let step = 1; step <= samples; step += 1) {
    const here = at(step);
    const before = at(step - 1);
    along.push(
      (along[step - 1] ?? 0) + Math.hypot(here.x - before.x, here.y - before.y)
    );
  }
  const length = along[samples] ?? 0;
  return Array.from({ length: count }, (_, index) => {
    const goal = (index * length) / count;
    return at(along.findIndex((each) => each >= goal));
  });
};

/** The measures a room gives the shape. */
interface Measures {
  W: number;
  H: number;
  top: number;
  foot: number;
  small: boolean;
  /** A team's radius in this room. */
  r: number;
  largest: number;
  reach: number;
  /** The room under a soma for its name and its hours. */
  named: number;
  weighed: boolean;
  peak: number;
}

const measuresOf = (figure: HoursFigure, room: MapRoom): Measures => {
  const W = room.width;
  const H = room.height;
  const small = W < PHONE.small;
  const line = small ? NAME.small : NAME.line;
  const r = Math.min(
    Math.max(Math.min(W, H) * TEAM_R.share, TEAM_R.least),
    TEAM_R.most
  );
  return {
    W,
    H,
    top: H / 2 - CAPTION.down - CAPTION.high / 2 - CAPTION.under,
    foot: -H / 2 + (W < PHONE.width ? PHONE.foot : 0),
    small,
    r,
    // The ring makes room for the largest from the start, so the work grows where it stands.
    largest: r * WORK_R.most,
    reach: r * WORK_R.most * TEAM_R.reach,
    // Under its name, once weighed, a workflow says its hours.
    named: NAME.gap + 3 * line + NAME.air,
    weighed: figure.move !== "work",
    peak: Math.max(0, ...figure.works.map(({ hours }) => hours ?? 0)),
  };
};

/** A workflow's radius, its area as its hours against the most hours `peak`: at most `most`, at least `least`, or `unknown` while they are not known. */
const sizeOf = (
  hours: number | null,
  peak: number,
  { most, least, unknown }: { most: number; least: number; unknown: number }
): number =>
  hours === null || peak === 0
    ? unknown
    : Math.max(least, most * Math.sqrt(hours / peak));

/** Places on the ring, or in rows where the ring would crowd, and how wide a name may be. */
const ringOrRows = (
  count: number,
  quiet: boolean,
  m: Measures,
  bottom: number
): { places: Point[]; nameRoom: number } => {
  const more = Math.max(0, count - RING_GROWS.from);
  const ringWide = Math.max(
    Math.min(
      m.W / 2 - RING.name - GRID.edge,
      RING.wide + more * RING_GROWS.across
    ),
    0
  );
  const ringHigh = Math.max(
    Math.min(
      (m.top - bottom - m.reach - m.largest - m.named) / 2,
      RING.high + more * RING_GROWS.up
    ),
    0
  );
  const middle = (m.top - m.reach + bottom + m.largest + m.named) / 2;
  const ring = ringPoints(count, ringWide, ringHigh, middle);
  const nearest =
    count > 1
      ? Math.min(
          ...ring.map((point, at) => {
            const next = ring[(at + 1) % count] ?? point;
            return Math.hypot(point.x - next.x, point.y - next.y);
          })
        )
      : m.W;
  if (nearest >= (quiet ? GRID.quiet : GRID.closest)) {
    // A name is never wider than the room to the work beside it on the ring.
    return {
      places: ring,
      nameRoom: Math.max(Math.min(2 * RING.name, nearest - 8), 80),
    };
  }
  // Too close on a ring: in rows, in their order, filling the room between the line and the foot.
  const across = Math.min(count, GRID.across);
  const rows = Math.ceil(count / across);
  const column = (m.W - 2 * GRID.edge) / across;
  const pitch =
    rows > 1
      ? Math.min(
          (m.top - m.reach - (bottom + m.largest + m.named)) / (rows - 1),
          GRID.pitch
        )
      : 0;
  const first = middle + (pitch * (rows - 1)) / 2;
  return {
    places: Array.from({ length: count }, (_, at) => ({
      x: -m.W / 2 + GRID.edge + column * ((at % across) + 0.5),
      y: first - Math.floor(at / across) * pitch,
    })),
    nameRoom: Math.max(column - 8, 80),
  };
};

/** The ones that take most of the hours, side by side in the middle of the room under the line, as large as it lets them be, each as its hours. */
const foundRow = (
  most: readonly FigureWork[],
  m: Measures
): { places: (Point & { r: number })[]; nameRoom: number } => {
  const spread =
    most.length > 1
      ? Math.min((m.W - 2 * RING.name) / (most.length - 1), FOUND.apart)
      : 0;
  const free = m.top - PAIR_UNDER - m.foot;
  const grown = Math.max(
    m.r,
    Math.min(
      FOUND.most,
      (most.length > 1 ? spread : m.W - 2 * RING.name) * FOUND.across,
      (free - m.named) / (TEAM_R.reach + 1)
    )
  );
  // Nothing past the room's sides, its dendrites spreading half as far again as its soma.
  const apart =
    most.length > 1
      ? Math.min(
          spread,
          (m.W / 2 - GRID.edge - grown * 1.5) / ((most.length - 1) / 2)
        )
      : 0;
  const peak = Math.max(0, ...most.map(({ hours }) => hours ?? 0));
  // Its dendrites over it and its name under it, the whole of it in the middle of the room left.
  const row =
    (m.top - PAIR_UNDER + m.foot) / 2 -
    (grown * TEAM_R.reach - grown - m.named) / 2;
  return {
    places: most.map((each, at) => ({
      x: (at - (most.length - 1) / 2) * apart,
      y: row,
      r: sizeOf(each.hours, peak, {
        most: grown,
        least: grown * WORK_R.least,
        unknown: grown * WORK_R.unknown,
      }),
    })),
    nameRoom:
      most.length > 1
        ? Math.max(Math.min(apart - 8, 2 * RING.name + 64), 80)
        : 2 * RING.name + 64,
  };
};

/** The shape in a room of so many pixels, in pixels from the room's middle, x to the right and y up, the line that says what Grasp does along the top. */
export const hoursMap = (figure: HoursFigure, room: MapRoom): ThinkingMap => {
  const m = measuresOf(figure, room);
  const neuron = (
    each: FigureWork,
    { x, y }: Point,
    more: Partial<ThinkingNeuron> = {}
  ): ThinkingNeuron => ({
    id: each.id,
    noteIds: each.noteId === undefined ? [] : [each.noteId],
    kind: "candidate",
    label: each.name,
    state: m.weighed && each.hours === null ? "waiting" : "known",
    group: 0,
    r: m.weighed
      ? sizeOf(each.hours, m.peak, {
          most: m.largest,
          least: m.r * WORK_R.least,
          unknown: m.r * WORK_R.unknown,
        })
      : m.r,
    x,
    y,
    crown: true,
    ...(m.weighed ? { hours: each.hours } : {}),
    ...more,
  });
  // Weighed, what is not known yet steps down to the foot, small and quiet: named only when pointed at.
  const unknown =
    m.weighed && figure.move !== "most"
      ? figure.works.filter(({ hours }) => hours === null)
      : [];
  const benchY = m.foot + m.named + m.r * WORK_R.unknown;
  const bottom =
    unknown.length > 0 ? benchY + m.r * WORK_R.unknown * TEAM_R.reach : m.foot;
  const { neurons, nameRoom } =
    figure.move === "most"
      ? (() => {
          const most = figure.works.filter(({ id }) =>
            figure.most.includes(id)
          );
          const found = foundRow(most, m);
          return {
            nameRoom: found.nameRoom,
            neurons: most.map((each, at) => {
              const place = found.places[at] ?? { x: 0, y: 0, r: m.r };
              return neuron(each, place, { r: place.r });
            }),
          };
        })()
      : (() => {
          const placed = figure.works.filter((each) => !unknown.includes(each));
          // While Grasp reads a long ring of it, the names wait to be pointed at; the beats light each in turn.
          const quiet = figure.move === "work" && placed.length > NAMED_UP_TO;
          const laid = ringOrRows(placed.length, quiet, m, bottom);
          return {
            nameRoom: laid.nameRoom,
            neurons: placed.map((each, at) =>
              neuron(
                each,
                laid.places[at] ?? { x: 0, y: 0 },
                quiet ? { quiet } : {}
              )
            ),
          };
        })();
  const apart = Math.min(
    BENCH.apart,
    (m.W - 2 * GRID.edge) / Math.max(unknown.length, 1)
  );
  for (const [at, each] of unknown.entries()) {
    neurons.push(
      neuron(
        each,
        { x: (at - (unknown.length - 1) / 2) * apart, y: benchY },
        { quiet: true }
      )
    );
  }
  return {
    neurons,
    names: { width: nameRoom, small: m.small },
    nerves: [],
    probes: [],
    said: Math.min(m.W - 32, 440),
    caption: {
      x: 0,
      y: m.H / 2 - CAPTION.down,
      width: Math.max(m.W - 32, 120),
    },
  };
};
