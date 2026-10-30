import type {
  Statement,
  StatementKind,
  Workspace,
} from "@grasp-os/shared/brain";
import type { ThinkingMove, ThinkingStep } from "@grasp-os/shared/thinking";

import type { MapRoom, NeuronState } from "../atlas-map.ts";
import type { Atlas } from "../brain-atlas.ts";
import type { Brain } from "../brain.ts";
import { BEAT, cut, inTurn, readFor, sayLength } from "./beats.ts";
import type { BeatSay, ThinkingBeat } from "./beats.ts";
import {
  CAPTION,
  NAME,
  PAIR_UNDER,
  PHONE,
  RING,
  SAG,
  TEAM_R,
} from "./layout.ts";
import type {
  ThinkingMap,
  ThinkingNerve,
  ThinkingNeuron,
  ThinkingProbe,
} from "./layout.ts";

// The shape of Grasp's thinking for whether the same pain hurts more than
// one team (grasplabs/prototype `lib/thinking-same-pain.ts`): the teams in
// a ring as Grasp reads what each says slows it down; a fine thread
// reaches out to each team in turn and pulls back, and the one between two
// teams that said the same holds; then the ring lets go, the teams that
// said it pull towards each other, and a nerve grows between them made of
// what they said, each thing said a bead on it. Pointed at, a bead says its
// words, with who said them as a role and a team, never a name, and the
// words both teams used underlined. Nothing is ranked or sized by how much
// was said: teams and what they said keep the brain's order. Pure.

/** What a team says slows it down: what Grasp reads for the same pain. */
const PAIN: ReadonlySet<StatementKind> = new Set<StatementKind>([
  "timeSink",
  "blocker",
  "handover",
]);

/** A team in the shape. */
export interface FigureTeam {
  id: string;
  name: string;
  state: NeuronState;
  /** It said one of the things found. */
  involved: boolean;
}

/** Something a team said slows it down. */
export interface FigureSaid {
  /** The statement's id. */
  id: string;
  teamId: string;
  sourceId: string;
  text: string;
  /** It is the same pain as something another team said. */
  found: boolean;
}

/** Something found, as the shape shows its words: who said them, and where. */
export interface FigureWord {
  id: string;
  text: string;
  /** Who said it, as a role and a team: never a name. */
  by: string;
  teamId: string;
  sourceId: string;
}

/** A thread Grasp tries from something found to something another team said: it holds when that is the same pain. */
export interface FigureProbe {
  from: string;
  to: string;
  holds: boolean;
}

/** The most of what a team said that a beat quotes, cut at a word. */
const QUOTE_MOST = 72;

/** What the same-pain shape shows at a step. */
export interface SamePainFigure {
  shape: "same-pain";
  move: ThinkingMove;
  /** How long the step's own sentence stays up before its first beat. */
  lead?: number;
  /** Every team looked at so far, in the brain's order. */
  teams: FigureTeam[];
  /** While Grasp reads and looks: what each team said slows it down. */
  said: FigureSaid[];
  /** What was found so far. */
  words: FigureWord[];
  /** While Grasp looks: the threads it tries, in order. */
  probes: FigureProbe[];
  /** The teams a nerve runs between: they said the same. */
  nerves: [string, string][];
  /** The words found in what more than one team said, as stems. */
  shared: string[];
  /** What stands out now: the notes the step looks at. */
  lit: string[];
}

/** The threads Grasp tries while it looks: one to each team that said nothing the same, pulling back; then one between each two that did, which holds. */
const probesOf = (
  teams: readonly FigureTeam[],
  said: readonly FigureSaid[]
): FigureProbe[] => {
  const found = said.filter((each) => each.found);
  const involved = teams.filter((team) => team.involved);
  const apart = (one: FigureTeam, other: FigureTeam): number => {
    const steps = Math.abs(teams.indexOf(one) - teams.indexOf(other));
    return Math.min(steps, teams.length - steps);
  };
  const misses = teams
    .filter((team) => !team.involved)
    .flatMap((team): FigureProbe[] => {
      const [nearest] = involved.toSorted(
        (one, other) => apart(one, team) - apart(other, team)
      );
      const from = found.find((each) => each.teamId === nearest?.id);
      const to = said.find((each) => each.teamId === team.id);
      return from === undefined || to === undefined
        ? []
        : [{ from: from.id, to: to.id, holds: false }];
    });
  const holds = involved.slice(1).flatMap((team, index): FigureProbe[] => {
    const from = found.find((each) => each.teamId === involved[index]?.id);
    const to = found.find((each) => each.teamId === team.id);
    return from === undefined || to === undefined
      ? []
      : [{ from: from.id, to: to.id, holds: true }];
  });
  return [...misses, ...holds];
};

/** Words too common to say two teams speak of the same thing. */
const COMMON = new Set(
  "a an the and or but to for of in on at by with without from as is are was be been it its this that these those we i you they he she our my your their us me them so what which who when where why how all every each one half some any no not do does don’t don't have has had should would could can will just again already now then there here than too very more most way see".split(
    " "
  )
);

const possessive = /[’']s$/u;

/** A word's stem, so "clients" and "client", "asking" and "asked" are one. */
const stem = (word: string): string => {
  const plain = word.toLowerCase().replace(possessive, "");
  if (plain.length > 5 && plain.endsWith("ing")) {
    return plain.slice(0, -3);
  }
  if (plain.length > 4 && plain.endsWith("ed")) {
    return plain.slice(0, -2);
  }
  if (plain.length > 3 && plain.endsWith("s") && !plain.endsWith("ss")) {
    return plain.slice(0, -1);
  }
  return plain;
};

const wordPattern = /[\p{L}\p{N}’']+/gu;
const wordsIn = (text: string): string[] => text.match(wordPattern) ?? [];

/** The stems that what more than one team said have in common, in the order first said. */
export const sharedStems = (words: readonly FigureWord[]): string[] => {
  const teamsOf = new Map<string, Set<string>>();
  const order: string[] = [];
  for (const word of words) {
    for (const each of wordsIn(word.text)) {
      const key = stem(each);
      if (!COMMON.has(each.toLowerCase()) && key.length >= 3) {
        if (!teamsOf.has(key)) {
          order.push(key);
        }
        teamsOf.set(key, (teamsOf.get(key) ?? new Set()).add(word.teamId));
      }
    }
  }
  return order.filter((key) => (teamsOf.get(key)?.size ?? 0) > 1);
};

const wordOrNot = /(?<word>[\p{L}\p{N}’']+)/u;

/** Something said, in pieces: the words both teams used marked, to be underlined. */
export const markShared = (
  text: string,
  shared: readonly string[]
): { text: string; shared: boolean }[] => {
  const keys = new Set(shared);
  const pieces: { text: string; shared: boolean }[] = [];
  for (const part of text.split(wordOrNot)) {
    if (part !== "") {
      const mark = keys.has(stem(part)) && !COMMON.has(part.toLowerCase());
      const last = pieces.at(-1);
      if (last?.shared === mark) {
        last.text += part;
      } else {
        pieces.push({ text: part, shared: mark });
      }
    }
  }
  return pieces;
};

/** Who said a statement: the team its source speaks for. */
const speakerOf =
  (ws: Workspace) =>
  (statement: Statement): string =>
    ws.sources.find(({ id }) => id === statement.sourceId)?.teamIds?.[0] ??
    statement.teamIds[0] ??
    "";

/** The first step of this step's run in its shape: what those steps looked at stays in view. */
const firstOfShape = (steps: readonly ThinkingStep[], at: number): number => {
  let first = at;
  while (first > 0 && steps[first - 1]?.shape === steps[at]?.shape) {
    first -= 1;
  }
  return first;
};

/**
 * What the same-pain shape shows at step `at`: everything this shape's
 * steps have looked at so far, in the move the step is in. Only notes in
 * the brain; nothing when there is no team to show.
 */
export const samePainAt = (
  steps: readonly ThinkingStep[],
  at: number,
  ws: Workspace,
  brain: Brain,
  atlas: Atlas
): SamePainFigure | undefined => {
  const step = steps[at];
  if (step?.shape !== "same-pain") {
    return undefined;
  }
  const looked = new Set(
    steps.slice(firstOfShape(steps, at), at + 1).flatMap(({ notes }) => notes)
  );
  const notes = new Map(brain.notes.map((note) => [note.id, note]));
  const speaker = speakerOf(ws);
  const inBrain = ws.statements.filter(
    (statement) => notes.get(speaker(statement))?.kind === "team"
  );
  const found =
    step.move === "teams" ? [] : inBrain.filter(({ id }) => looked.has(id));
  const involved = new Set(found.map(speaker));
  const asked = new Set(
    atlas.open
      .filter((item) => notes.get(item.noteId)?.kind !== "gap")
      .flatMap((item) => item.subjects)
  );
  const waiting = new Set(atlas.regions.flatMap((each) => each.waiting));
  const stateOf = (id: string): NeuronState => {
    if (asked.has(id)) {
      return "open";
    }
    return waiting.has(id) ? "waiting" : "known";
  };
  const teams = ws.teams
    .filter(
      (team) =>
        notes.get(team.id)?.kind === "team" &&
        (looked.has(team.id) || involved.has(team.id))
    )
    .map((team): FigureTeam => ({
      id: team.id,
      name: team.name,
      state: stateOf(team.id),
      involved: involved.has(team.id),
    }));
  if (teams.length === 0) {
    return undefined;
  }
  const read = new Set(teams.map(({ id }) => id));
  const foundIds = new Set(found.map(({ id }) => id));
  const reading = step.move === "teams" || step.move === "said";
  const said = reading
    ? inBrain
        .filter(
          (statement) =>
            read.has(speaker(statement)) &&
            (PAIN.has(statement.kind) || foundIds.has(statement.id))
        )
        .map((statement): FigureSaid => ({
          id: statement.id,
          teamId: speaker(statement),
          sourceId: statement.sourceId,
          text: statement.text,
          found: foundIds.has(statement.id),
        }))
    : [];
  const words = found.map((statement): FigureWord => {
    const teamId = speaker(statement);
    const team = ws.teams.find(({ id }) => id === teamId)?.name ?? "";
    const role = ws.sources.find(({ id }) => id === statement.sourceId)?.who;
    return {
      id: statement.id,
      text: statement.text,
      by: role === undefined ? team : `${role} · ${team}`,
      teamId,
      sourceId: statement.sourceId,
    };
  });
  const pair = teams.filter((team) => team.involved);
  const nerves =
    step.move === "together"
      ? pair
          .slice(1)
          .map((team, index): [string, string] => [
            pair[index]?.id ?? "",
            team.id,
          ])
      : [];
  const probes = step.move === "said" ? probesOf(teams, said) : [];
  const shown = new Set([
    ...teams.map(({ id }) => id),
    ...said.map(({ id }) => id),
    ...words.map(({ id }) => id),
  ]);
  const extra =
    step.move === "teams"
      ? []
      : [...pair.map(({ id }) => id), ...words.map(({ id }) => id)];
  const lit = [...new Set([...step.notes, ...extra])].filter((id) =>
    shown.has(id)
  );
  return {
    shape: "same-pain",
    move: step.move,
    teams,
    said,
    words,
    probes,
    nerves,
    shared: sharedStems(words),
    lit,
  };
};

/** The teams that said the same pull towards each other: to this share of the room they had on the ring, never closer than their names need. */
const PULL = { least: 104 };
/** The pair found fills the room under the line: the largest a team gets, its share of how far apart they stand, how close they pull, and the room kept under the nerve for the words. */
const PAIR_FOUND = { most: 76, share: 0.22, pull: 0.85, words: 96 };
/** What was said, under the nerve: the widest its words get, and the room over them. */
const QUOTES = { most: 440, over: 6 };
/** How far a thread reaches that does not hold. */
const THREADS = { least: 0.35, more: 0.3 };

/** What the brain says as each thread runs: which team says the same, and which does not. */
const threadSays = (figure: SamePainFigure): (BeatSay | null)[] => {
  const name = new Map(figure.teams.map((team) => [team.id, team.name]));
  const teamOf = new Map(figure.said.map((each) => [each.id, each.teamId]));
  return figure.probes.map((probe) => {
    const team = name.get(teamOf.get(probe.to) ?? "");
    if (teamOf.get(probe.from) === undefined || team === undefined) {
      return null;
    }
    return probe.holds ? { kind: "same", team } : { kind: "other", team };
  });
};

/** When each thread sets off after its step began: one after the other, each as its line is said. */
const threadDelays = (figure: SamePainFigure): number[] => {
  let delay = figure.lead ?? BEAT.lead;
  return threadSays(figure).map((say) => {
    const at = delay;
    delay += readFor(say === null ? 0 : sayLength(say));
    return at;
  });
};

/**
 * What the brain does, beat by beat: reading, what each team says slows it
 * down; looking, each thread it tries, which team says the same and which
 * does not; pulled together, only the finding.
 */
export const samePainBeats = (figure: SamePainFigure): ThinkingBeat[] => {
  if (figure.move === "teams") {
    return inTurn(
      figure.teams.map((team) => {
        const pain = figure.said.find((each) => each.teamId === team.id);
        return {
          lit: [team.id],
          say:
            pain === undefined
              ? { kind: "reading" as const, name: team.name }
              : {
                  kind: "pain" as const,
                  team: team.name,
                  words: cut(pain.text, QUOTE_MOST),
                },
        };
      }),
      figure.lead
    );
  }
  if (figure.move !== "said") {
    return [];
  }
  const teamOf = new Map(figure.said.map((each) => [each.id, each.teamId]));
  const delays = threadDelays(figure);
  const says = threadSays(figure);
  return figure.probes.flatMap((probe, index): ThinkingBeat[] => {
    const from = teamOf.get(probe.from);
    const to = teamOf.get(probe.to);
    const say = says[index];
    return from === undefined ||
      to === undefined ||
      say === undefined ||
      say === null
      ? []
      : [{ at: delays[index] ?? 0, lit: [from, to], say }];
  });
};

/** The room's measures every placement shares. */
interface Room {
  top: number;
  bottom: number;
  r: number;
  reach: number;
  named: number;
  line: number;
  ringWide: number;
  ringHigh: number;
  ringMiddle: number;
  count: number;
}

const roomFor = (figure: SamePainFigure, room: MapRoom): Room => {
  const W = room.width;
  const H = room.height;
  const top = H / 2 - CAPTION.down - CAPTION.high / 2 - CAPTION.under;
  // On a phone the way back stands at the foot of the room.
  const bottom = -H / 2 + (W < PHONE.width ? PHONE.foot : 0);
  const line = W < PHONE.small ? NAME.small : NAME.line;
  const r = Math.min(
    Math.max(Math.min(W, H) * TEAM_R.share, TEAM_R.least),
    TEAM_R.most
  );
  const reach = r * TEAM_R.reach;
  const named = NAME.gap + 2 * line + NAME.air;
  return {
    top,
    bottom,
    r,
    reach,
    named,
    line,
    ringWide: Math.max(Math.min(W / 2 - RING.name - 16, RING.wide), 0),
    ringHigh: Math.max(
      Math.min((top - bottom - reach - r - named) / 2, RING.high),
      0
    ),
    ringMiddle: (top - reach + bottom + r + named) / 2,
    count: figure.teams.length,
  };
};

/** Where team `at` stands on the ring, from the top left round. */
const ringAt = (room: Room, at: number): { x: number; y: number } => {
  if (room.count === 1) {
    return { x: 0, y: room.ringMiddle };
  }
  const angle =
    Math.PI / 2 + Math.PI / room.count - (at * 2 * Math.PI) / room.count;
  return {
    x: room.ringWide * Math.cos(angle),
    y: room.ringMiddle + room.ringHigh * Math.sin(angle),
  };
};

const teamNeuron = (
  each: FigureTeam,
  x: number,
  y: number,
  r: number
): ThinkingNeuron => ({
  id: each.id,
  noteIds: [each.id],
  kind: "team",
  label: each.name,
  state: each.state,
  group: 0,
  r,
  x,
  y,
  crown: true,
});

/** The ring: every team looked at so far, as large as the room lets them be. */
const ringOf = (
  figure: SamePainFigure,
  room: Room,
  width: number
): { neurons: ThinkingNeuron[]; nameRoom: number } => {
  const places = figure.teams.map((_, at) => ringAt(room, at));
  const gaps = places.map((place, at) => {
    const next = places[(at + 1) % places.length] ?? place;
    return Math.hypot(place.x - next.x, place.y - next.y);
  });
  const nearest = room.count > 1 ? Math.min(...gaps) : width;
  return {
    neurons: figure.teams.map((each, at) =>
      teamNeuron(each, places[at]?.x ?? 0, places[at]?.y ?? 0, room.r)
    ),
    nameRoom: Math.max(Math.min(2 * RING.name, nearest - 8), 80),
  };
};

/** A point along a nerve's curve from `ax` to `bx` on a row, sagging. */
const alongNerve = (
  ax: number,
  bx: number,
  row: number,
  t: number
): { x: number; y: number } => {
  const cx = (ax + bx) / 2;
  const cy = row - (bx - ax) * SAG;
  return {
    x: (1 - t) ** 2 * ax + 2 * t * (1 - t) * cx + t ** 2 * bx,
    y: (1 - t) ** 2 * row + 2 * t * (1 - t) * cy + t ** 2 * row,
  };
};

/** The teams that said the same, pulled together under the line, the nerve between them with what they said as beads. */
const pairOf = (
  figure: SamePainFigure,
  room: Room,
  width: number
): { neurons: ThinkingNeuron[]; nerves: ThinkingNerve[]; nameRoom: number } => {
  const pair = figure.teams.filter((each) => each.involved);
  const stood = pair.map((each) => ringAt(room, figure.teams.indexOf(each)));
  const before = Math.min(
    ...stood
      .slice(1)
      .map((at, index) =>
        Math.hypot(at.x - (stood[index]?.x ?? 0), at.y - (stood[index]?.y ?? 0))
      )
  );
  const several = pair.length > 1;
  const near = several
    ? Math.min(
        before,
        Math.max(PULL.least, before * PAIR_FOUND.pull),
        width - 2 * RING.name
      )
    : 0;
  const free =
    room.top - PAIR_UNDER - room.bottom - room.named - PAIR_FOUND.words;
  const grown = Math.max(
    room.r,
    Math.min(
      PAIR_FOUND.most,
      (several ? near : width - 2 * RING.name) * PAIR_FOUND.share,
      free / (TEAM_R.reach + 1)
    )
  );
  const apart = several
    ? Math.min(near, (width / 2 - 16 - grown * 1.5) / ((pair.length - 1) / 2))
    : 0;
  const nameRoom = several
    ? Math.max(Math.min(apart - 8, 2 * RING.name + 64), 80)
    : 2 * RING.name + 64;
  const beadR = Math.max(4, room.r * 0.32);
  const sag = (apart - 2 * grown) * SAG * 0.5;
  const hang = Math.max(grown + room.named, sag + beadR + room.line);
  const row =
    (room.top - PAIR_UNDER + room.bottom) / 2 -
    (grown * TEAM_R.reach - hang - PAIR_FOUND.words) / 2;
  const neurons = pair.map((each, at) =>
    teamNeuron(each, (at - (pair.length - 1) / 2) * apart, row, grown)
  );
  const nerves = pair
    .slice(1)
    .map((_, at): ThinkingNerve => ({ from: at, to: at + 1, bow: SAG }));
  const beads = pair.flatMap((each, at) => {
    const own = figure.words.filter((word) => word.teamId === each.id);
    const leftward = at === pair.length - 1 && at > 0;
    const start = leftward ? at - 1 : at;
    const ax = (neurons[start]?.x ?? 0) + grown;
    const bx = (neurons[Math.min(start + 1, pair.length - 1)]?.x ?? 0) - grown;
    return own.map((word, order): ThinkingNeuron => {
      const share = (0.5 * (order + 1)) / (own.length + 1);
      const place = alongNerve(ax, bx, row, leftward ? 1 - share : share);
      return {
        id: word.id,
        noteIds: [word.sourceId],
        kind: "statement",
        label: word.text,
        state: "known",
        group: 0,
        r: beadR,
        x: place.x,
        y: place.y,
        bare: true,
        quiet: true,
        by: word.by,
        say: { x: 0, y: row - hang - QUOTES.over },
        marks: figure.shared,
      };
    });
  });
  return { neurons: [...neurons, ...beads], nerves, nameRoom };
};

/**
 * The shape in a room of so many pixels, in pixels from the room's middle,
 * x to the right and y up, with the line along the top: the ring while
 * Grasp reads and looks, with the threads it tries between the teams; then
 * the pair that said the same, pulled together under the line.
 */
export const samePainMap = (
  figure: SamePainFigure,
  room: MapRoom
): ThinkingMap => {
  const measures = roomFor(figure, room);
  const pulled =
    figure.move === "together" && figure.teams.some((team) => team.involved);
  const laid = pulled
    ? pairOf(figure, measures, room.width)
    : { ...ringOf(figure, measures, room.width), nerves: [] };
  const place = new Map(
    laid.neurons.map((neuron, index) => [neuron.id, index])
  );
  const teamOf = new Map(figure.said.map((each) => [each.id, each.teamId]));
  const delays = threadDelays(figure);
  const probes = figure.probes.flatMap((probe, index): ThinkingProbe[] => {
    const from = place.get(teamOf.get(probe.from) ?? probe.from);
    const to = place.get(teamOf.get(probe.to) ?? probe.to);
    return from === undefined || to === undefined
      ? []
      : [
          {
            from,
            to,
            holds: probe.holds,
            delay: delays[index] ?? 0,
            reach: THREADS.least + (THREADS.more * ((index * 7) % 5)) / 4,
          },
        ];
  });
  return {
    neurons: laid.neurons,
    nerves: laid.nerves,
    probes,
    names: { width: laid.nameRoom, small: room.width < PHONE.small },
    said: Math.min(room.width - 32, QUOTES.most),
    caption: {
      x: 0,
      y: room.height / 2 - CAPTION.down,
      width: Math.max(room.width - 32, 120),
    },
  };
};
