import { t } from "@lingui/core/macro";

import { REGION_IDS } from "./brain-atlas.ts";
import type { Atlas, AtlasRegion, RegionId } from "./brain-atlas.ts";
import { folderName } from "./brain.ts";
import type { Brain, Note, NoteKind } from "./brain.ts";
import {
  ATLAS_REGION_COUNT,
  brainCloud,
  CLOUD_PITCH,
  SPINE_PITCH,
} from "./dot-shapes.ts";

/**
 * The atlas: the brain in 3D, turning, and one region of it up close as a slice of cortex. Each
 * note is a neuron, a soma of dots sized by its links, with a few dendrites. The notes of one
 * folder sit together under the folder's name, in rows that interlock as cells in tissue do, so a
 * region reads folder by folder; a folder with many notes in it is one neuron until it is opened;
 * an open question sits against what it is about as a small neuron of its own. Links between
 * notes are synapses. Links to other regions leave as axons, upwards, to where each region's
 * name waits along the top. A region can be narrowed to one of its folders, its groups: the tools
 * people named, or the employee interviews, every note of it shown. A map is laid out for the room
 * it has on screen, in pixels: every neuron gets at least the room its name needs, groups wrap
 * under each other where the room is narrow, and where even that is not enough the fullest
 * folders fold into one neuron each. Laid out the same way every time. Pure numbers.
 */

/**
 * A folder with more notes than this in one region is shown as one neuron: the employee
 * interviews. In a room too small to name every note, folders fold sooner, the largest first,
 * until everything shown has a name that can be read. A region holding more notes than
 * `GROUPS_AT` shows each of its folders as one neuron to begin with, as the tools and the sources
 * do: a folder opens as the region narrowed to it.
 */
const CLUSTER_AT = 20;
const FOLDS = [CLUSTER_AT, 14, 8, 5, 3, 2, 1];
const GROUPS_AT = 20;

/** A folder of notes shown as one neuron has its folder's path for an id, after this. */
const CLUSTER = "cluster:";

/** A value of a typed or plain array, or 0 past its end. */
const at = (values: ArrayLike<number>, index: number): number =>
  values[index] ?? 0;

/** The folder a folded neuron stands for. */
export const clusterFolder = (id: string): string => id.slice(CLUSTER.length);

/** A folder a region can be narrowed to: its path in the vault, its name, and how many notes it holds. */
export interface RegionGroup {
  key: string;
  label: string;
  count: number;
}

/** The notes a region shows as neurons: a folder's own note names its group instead, and a gap sits beside what it is about, except among the gaps. */
const shownNotes = (regionId: RegionId, atlas: Atlas): Note[] => {
  const region = atlas.regions.find((each) => each.id === regionId);
  return (region?.notes ?? []).filter(
    (note) =>
      note.kind !== "channel" && (note.kind !== "gap" || regionId === "gaps")
  );
};

/** The folders a region can be narrowed to, in the vault's order; none when it is one folder. */
export const regionGroups = (
  regionId: RegionId,
  atlas: Atlas
): RegionGroup[] => {
  const groups = new Map<string, RegionGroup>();
  for (const note of shownNotes(regionId, atlas)) {
    const key = note.path.join("/");
    const group = groups.get(key) ?? {
      key,
      label: folderName(note.path.at(-1) ?? key),
      count: 0,
    };
    group.count += 1;
    groups.set(key, group);
  }
  return groups.size > 1 ? [...groups.values()] : [];
};

/** The room a map's neurons have on screen, in pixels. */
export interface MapRoom {
  width: number;
  height: number;
}

/** A room to lay a region out in when it is its neurons that are wanted, not where they sit. */
export const MAP_ROOM: MapRoom = { width: 960, height: 640 };

/** How far the camera goes in on a region: its map is printed for it, so dots keep their size. */
export const REGION_ZOOM = 2.4;

/** How many dots the atlas draws with: the whole brain's, which every figure shares. */
export const atlasCount = (): number => brainCloud().count;

/** How many of them are the brain itself; the ones after them are the spine it runs on into. */
export const atlasBody = (): number => brainCloud().body;

/** How the brain is turned: round its up axis (yaw), then leaning towards you (pitch), in radians. */
export interface Turn {
  yaw: number;
  pitch: number;
}

/** At rest: from the right side, turned a little towards the front, which faces left, and a little from above. */
export const RESTING: Turn = { yaw: -1.22, pitch: 0.14 };

/** A point of the brain as seen turned: x right, y up, z towards you. */
export const turnPoint = (
  x: number,
  y: number,
  z: number,
  turn: Turn
): [number, number, number] => {
  const cy = Math.cos(turn.yaw);
  const sy = Math.sin(turn.yaw);
  const x1 = cy * x + sy * z;
  const z1 = -sy * x + cy * z;
  const cp = Math.cos(turn.pitch);
  const sp = Math.sin(turn.pitch);
  return [x1, cp * y - sp * z1, sp * y + cp * z1];
};

/** Where a region sits on the brain and which way it faces: its dots' middle and mean normal, on the right half for a lobe. */
interface Side {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

let sides: Side[][] | null = null;

/**
 * Each region's sides: the four lobes on the right half and the left, the cerebellum and the stem
 * once, in the middle. The right half's comes first: the one a region is turned to show. The spine
 * is left out, so the stem's side stays on the stem.
 */
export const regionSides = (): Side[][] => {
  if (sides) {
    return sides;
  }
  const cloud = brainCloud();
  const sums = Array.from({ length: ATLAS_REGION_COUNT }, () =>
    [0, 1].map(() => ({ x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, count: 0 }))
  );
  for (let index = 0; index < cloud.body; index += 1) {
    const region = at(cloud.region, index);
    const x = at(cloud.x, index);
    // The lobes come in two halves; the cerebellum and the stem are one.
    const half = region < 4 && x < 0 ? 1 : 0;
    const sum = sums[region]?.[half];
    if (!sum) {
      continue;
    }
    sum.x += x;
    sum.y += at(cloud.y, index);
    sum.z += at(cloud.z, index);
    sum.nx += at(cloud.nx, index);
    sum.ny += at(cloud.ny, index);
    sum.nz += at(cloud.nz, index);
    sum.count += 1;
  }
  sides = sums.map((halves) =>
    halves
      .filter((sum) => sum.count > 0)
      .map((sum) => {
        const length = Math.hypot(sum.nx, sum.ny, sum.nz) || 1;
        return {
          x: sum.x / sum.count,
          y: sum.y / sum.count,
          z: sum.z / sum.count,
          nx: sum.nx / length,
          ny: sum.ny / length,
          nz: sum.nz / length,
        };
      })
  );
  return sides;
};

/** The side a region is turned to show: its right half's, for a lobe. */
const shownSide = (region: number): Side =>
  regionSides()[region]?.[0] ?? { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 1 };

/** How to turn the brain so a region faces you, leaning part of the way towards its top or its bottom. */
export const facingTurn = (region: number): Turn => {
  const side = shownSide(region);
  const yaw = Math.atan2(-side.nx, side.nz);
  const flat = Math.hypot(side.nx, side.nz);
  const pitch = Math.max(-0.7, Math.min(0.7, Math.atan2(side.ny, flat) * 0.75));
  return { yaw, pitch };
};

/** Where a region's middle is, seen with the brain turned to face it: where its map opens. */
export const regionInView = (region: number): { x: number; y: number } => {
  const side = shownSide(region);
  const [x, y] = turnPoint(side.x, side.y, side.z, facingTurn(region));
  return { x, y };
};

/** How a dot shows what it stands for: filled where something is known, hollow where it is still waiting, in the attention colour where a question is open. */
export const KNOWN = 0;
export const WAITING = 1;
export const OPEN_MARK = 2;

export type NeuronState = "known" | "waiting" | "open";

export interface Neuron {
  /** The note's id, or `cluster:<folder>` for a folder of notes. */
  id: string;
  /** The notes it stands for: one, or a folder's. */
  noteIds: string[];
  kind: NoteKind | "cluster";
  /** Its note's title, without what its folder's name already says; for a folder, its name and how many notes it holds; for an open question, the question. */
  label: string;
  /** The title in full, when the label leaves part of it off. */
  title?: string;
  state: NeuronState;
  /** The group it sits in. */
  group: number;
  /** For an open question: the neuron it sits against. */
  beside?: number;
  /** Its soma's radius, in pixels, from how linked it is. */
  r: number;
  /** Where it sits, in pixels from the middle of the map's room: x to the right, y up. */
  x: number;
  y: number;
}

/** A folder of the region's notes: its neurons sit together under its name. */
export interface Group {
  /** The folder's name, as the vault has it. */
  label: string;
  /** The folder's own note, when it has one: its name opens it. */
  noteId?: string;
  /** The folder above it, when that has a note of its own. */
  parent?: { label: string; noteId: string };
  /** Where its name sits, in the map's pixels: over its neurons, from their left, standing on `y`; and how wide the group is, which its name keeps within. */
  x: number;
  y: number;
  width: number;
  /** How many lines its name takes over its neurons: none when it is not named, as a group of one neuron, or the only group of its region. */
  lines: number;
}

/** Where the links to another region leave the map, and from which neurons. */
export interface Exit {
  region: RegionId;
  x: number;
  y: number;
  /** Links between the two regions in the brain. */
  count: number;
  from: number[];
}

/** The room one neuron has with its name under it, in pixels. */
export interface Cell {
  width: number;
  height: number;
  /** The largest a soma is in it. */
  soma: number;
  /** How many lines a name may take, how many more the longest name here would need, and whether names are set a size smaller. */
  lines: number;
  short: number;
  small: boolean;
}

export interface NeuronMap {
  region: RegionId;
  neurons: Neuron[];
  groups: Group[];
  synapses: [number, number][];
  exits: Exit[];
  /** The room it is laid out in. */
  room: MapRoom;
  cell: Cell;
  /** Whether every neuron has the room its name needs: false only when the room is too small even with every folder folded. */
  fits: boolean;
}

/**
 * What a neuron needs on screen, in pixels: the least a cell may be, which is a name wide enough to
 * read with a small soma over it; and the most, however much room there is, so a few notes on a
 * large screen stay a group rather than drift apart.
 */
const CELL = {
  least: { width: 92, height: 76 },
  most: { width: 300, height: 250 },
};
/** A cell is about this much wider than it is high: a name takes more room across than a soma does down. */
const ASPECT = 1.2;
/** The smallest and the largest a soma's radius gets. */
const SOMA_R = { least: 9, most: 58 };
/**
 * A name under a soma: what a line takes, set normally and a size smaller; what goes around it:
 * the gap under the soma, the name's own edge, and air under it; about how wide a letter is at
 * either size, on the wide side; how much narrower than its cell a name is, and what its own edge
 * takes from that; the widest and the narrowest a name gets; and the smallest soma a name of
 * several lines still leaves room for.
 */
const NAME = {
  line: 17.5,
  small: 15,
  around: 20,
  letter: 7.8,
  smallLetter: 6.6,
  inset: 6,
  edge: 10,
  widest: 240,
  narrowest: 80,
  soma: 11,
};
/** How far a neuron sits off the middle of its cell, either way, as a share of the cell: the unevenness of tissue. */
const UNEVEN = 0.03;
/** How far over the room the ways out wait, in pixels, until the atlas places them. */
const EXITS = 48;
/** The room between two groups side by side, in a wide room and a narrow one, and between two bands of them. */
const BETWEEN = { wide: 28, narrow: 16, from: 700 };
const BAND_GAP = 14;
/** What the groups' names take over a band, on one line and on two; about how wide a letter of one is, and how high a line. */
const HEAD = { one: 22, two: 36, letter: 6.4, line: 15 };
/** How far every other column sits lower than its neighbours, as a share of a cell's height: in full where cells are high, not at all where they are low and every pixel is a name's. */
const STAGGER = { share: 0.28, from: 90, full: 150 };
/** The most bands of groups under each other, and rows in one. */
const BANDS = 4;
const ROWS = 8;

/** The cell a map with nothing in it has. */
const emptyCell = (): Cell => ({
  width: CELL.most.width,
  height: CELL.most.height,
  soma: SOMA_R.most,
  lines: 3,
  short: 0,
  small: false,
});

/* oxlint-disable no-bitwise, unicorn/prefer-math-trunc, unicorn/prefer-code-point -- a seeded random and a string hash are 32-bit arithmetic on UTF-16 units, as the prototype's: Math.trunc and codePointAt would change their numbers */

/** A small seeded random (mulberry32), so a neuron grows the same way each time. */
const seeded = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** A small stable number for a string, for a neuron's own bends. */
const hash = (text: string): number => {
  let value = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    value = Math.imul(value ^ text.charCodeAt(index), 16_777_619);
  }
  return Math.abs(value);
};

/** Whether bit `index` of `bits` is set. */
const bitSet = (bits: number, index: number): boolean =>
  (bits & (1 << index)) !== 0;

/** 2 to the power of `count`, as a shift. */
const twoTo = (count: number): number => 1 << count;

/* oxlint-enable no-bitwise, unicorn/prefer-math-trunc, unicorn/prefer-code-point */

/** How wide a name may be in a cell so wide: narrower than the cell by more than its neurons are uneven, so two names side by side never touch. */
export const nameWidth = (cell: number): number =>
  Math.min(
    NAME.widest,
    Math.max(NAME.narrowest, cell - Math.max(NAME.inset, cell * UNEVEN * 2 + 2))
  );

/**
 * The words the titles of a folder's notes start with, when two in three of them share them:
 * "Interview with", in a folder of interviews. Empty when they share none.
 */
const sharedStart = (titles: string[]): string => {
  if (titles.length < 3) {
    return "";
  }
  const words = titles.map((title) => title.split(" "));
  let shared = "";
  for (let length = 1; length <= 4; length += 1) {
    const counts = new Map<string, number>();
    for (const each of words) {
      if (each.length <= length) {
        continue;
      }
      const start = each.slice(0, length).join(" ");
      counts.set(start, (counts.get(start) ?? 0) + 1);
    }
    const [start, count] = [...counts.entries()].toSorted(
      (a, b) => b[1] - a[1]
    )[0] ?? ["", 0];
    if (count * 3 < titles.length * 2) {
      break;
    }
    shared = start;
  }
  return shared;
};

/** Neurons laid out as one block of cells: a group with a name over it, or the neurons of several groups too small for one. */
interface Block {
  groups: number[];
  own: number[];
  /** How long its name is, in letters; 0 when it has none. */
  name: number;
}

/** A band of blocks side by side, in so many rows. */
interface Band {
  blocks: Block[];
  rows: number;
  used: number;
  columns: number;
  head: number;
}

/** Blocks side by side in bands under each other, as lines of text wrap: which blocks each band holds, in how many rows, and the cell that leaves every neuron. */
interface Bands {
  bands: Band[];
  width: number;
  height: number;
  /** How far every other column sits lower, as a share of the cell's height. */
  stagger: number;
}

/** How many columns a block's neurons take in so many rows. */
const columnsOf = (block: Block, rows: number): number =>
  Math.ceil(block.own.length / rows);

const staggerAt = (height: number): number =>
  STAGGER.share *
  Math.min(
    1,
    Math.max(0, (height - STAGGER.from) / (STAGGER.full - STAGGER.from))
  );

/** The blocks in order, broken into bands where `breaks` has a bit set: bit `at` means a new band starts after block `at`. */
const bandsFor = (blocks: Block[], breaks: number): Block[][] => {
  const bands: Block[][] = [];
  let band: Block[] = [];
  for (const [index, block] of blocks.entries()) {
    band.push(block);
    if (index < blocks.length - 1 && bitSet(breaks, index)) {
      bands.push(band);
      band = [];
    }
  }
  bands.push(band);
  return bands;
};

/** Bands of blocks, each in its number of rows, with what each band uses and its names' head. */
const laidOut = (bands: Block[][], rows: number[]): Band[] =>
  bands.map((blocks, index) => {
    const many = rows[index] ?? 1;
    const band: Band = {
      blocks,
      rows: many,
      used: Math.max(
        ...blocks.map((block) =>
          Math.ceil(block.own.length / columnsOf(block, many))
        )
      ),
      columns: blocks.reduce((sum, block) => sum + columnsOf(block, many), 0),
      head: 0,
    };
    return band;
  });

/** How wide a cell can be when these bands share the room's width. */
const widthFor = (bands: Band[], room: MapRoom, between: number): number =>
  Math.min(
    ...bands.map(
      (band) => (room.width - (band.blocks.length - 1) * between) / band.columns
    )
  );

/** A band's names take one line where every name fits over its own block, two where one does not. */
const headOf = (band: Band, cell: number): number => {
  const names = band.blocks.filter((block) => block.name > 0);
  if (names.length === 0) {
    return 0;
  }
  return names.some(
    (block) => block.name * HEAD.letter > columnsOf(block, band.rows) * cell - 8
  )
    ? HEAD.two
    : HEAD.one;
};

/** Rows per band as an odometer: the next way, or false once every way was tried. */
const nextRows = (rows: number[], tallest: number[]): boolean => {
  let index = 0;
  while (index < rows.length && (rows[index] ?? 1) >= (tallest[index] ?? 1)) {
    rows[index] = 1;
    index += 1;
  }
  if (index === rows.length) {
    return false;
  }
  rows[index] = (rows[index] ?? 1) + 1;
  return true;
};

/** How these bands, in these rows, lay out in the room, and how good that is: the room every neuron gets. */
const tryBands = (
  bands: Block[][],
  rows: number[],
  room: MapRoom,
  between: number
): { plan: Bands; score: number } => {
  const laid = laidOut(bands, rows);
  const width = widthFor(laid, room, between);
  const cell = Math.min(width, CELL.most.width);
  for (const band of laid) {
    band.head = headOf(band, cell);
  }
  const free =
    room.height -
    laid.reduce((sum, band) => sum + band.head, 0) -
    (laid.length - 1) * BAND_GAP;
  const total = laid.reduce((sum, band) => sum + band.used, 0);
  const staggered = laid.filter((band) => band.columns > 1).length;
  // The stagger takes height, and how much there is depends on the height: settled in a few rounds.
  let stagger = 0;
  let height = free / total;
  for (let round = 0; round < 3; round += 1) {
    stagger = staggerAt(Math.min(height, CELL.most.height));
    height = free / (total + staggered * stagger);
  }
  const score =
    Math.min(cell / ASPECT, Math.min(height, CELL.most.height)) -
    0.01 * laid.length -
    0.001 * total;
  return { plan: { bands: laid, width, height, stagger }, score };
};

/**
 * The arrangement that gives every neuron the most room: the blocks in the vault's order, wrapped
 * into bands, each band in as many rows as serve it, tried every way. A wide room gets one band, a
 * narrow one several; a tie goes to fewer bands, then fewer rows.
 */
const arrange = (blocks: Block[], room: MapRoom): Bands => {
  const count = blocks.length;
  const between = room.width < BETWEEN.from ? BETWEEN.narrow : BETWEEN.wide;
  let best: Bands = {
    bands: [],
    width: CELL.most.width,
    height: CELL.most.height,
    stagger: 0,
  };
  let bestScore = Number.NEGATIVE_INFINITY;
  // Every way to break the line of blocks. With very many blocks, only the first ways are tried.
  const ways = twoTo(Math.min(Math.max(count - 1, 0), 12));
  for (let breaks = 0; breaks < ways; breaks += 1) {
    const bands = bandsFor(blocks, breaks);
    if (bands.length > BANDS) {
      continue;
    }
    const tallest = bands.map((band) =>
      Math.min(ROWS, Math.max(...band.map((block) => block.own.length)))
    );
    const rows = bands.map(() => 1);
    // Every number of rows per band, as an odometer.
    do {
      const { plan, score } = tryBands(bands, rows, room, between);
      if (score > bestScore) {
        bestScore = score;
        best = plan;
      }
    } while (nextRows(rows, tallest));
  }
  return best;
};

/**
 * Groups as blocks of cells: a group is named over its neurons when it has several, and the region
 * more than one group. The ones between two named groups that are not, one neuron each, sit together.
 */
const blocksOf = (neurons: Neuron[], groups: Group[]): Block[] => {
  const blocks: Block[] = [];
  for (const [group, each] of groups.entries()) {
    const own = neurons.flatMap((neuron, index) =>
      neuron.group === group && neuron.beside === undefined ? [index] : []
    );
    if (own.length === 0) {
      continue;
    }
    const named =
      groups.length > 1 &&
      own.filter((index) => neurons[index]?.kind !== "gap").length >= 2;
    const last = blocks.at(-1);
    if (!named && last && last.name === 0) {
      last.groups.push(group);
      last.own.push(...own);
    } else {
      blocks.push({
        groups: [group],
        own,
        name: named ? each.label.length : 0,
      });
    }
  }
  return blocks;
};

/** The name lines a cell gives, the soma it leaves, and whether that is enough to read. */
const cellOf = (
  neurons: Neuron[],
  plan: Bands
): { cell: Cell; fits: boolean } => {
  const width = Math.max(Math.min(plan.width, CELL.most.width), 1);
  const height = Math.max(Math.min(plan.height, CELL.most.height), 1);
  // A full region, or a small cell, names its notes a size smaller.
  const small = neurons.length > 12 || width < 120 || height < 100;
  const line = small ? NAME.small : NAME.line;
  // As many lines as the longest name here needs, up to three, while they leave a soma worth having: a name in full matters more than a larger soma, and short names leave the room to the soma.
  const somaWith = (lines: number) =>
    Math.min(
      width * 0.27,
      (height - lines * line - NAME.around - 6) / 2,
      SOMA_R.most
    );
  const words = nameWidth(width) - NAME.edge;
  const letter = small ? NAME.smallLetter : NAME.letter;
  const longest = Math.min(
    3,
    Math.max(
      1,
      ...neurons
        .filter((neuron) => neuron.kind !== "gap")
        .map((neuron) => Math.ceil((neuron.label.length * letter) / words))
    )
  );
  const lines =
    [3, 2, 1].find(
      (each) => each <= longest && (each === 1 || somaWith(each) >= NAME.soma)
    ) ?? 1;
  // It fits when every neuron has the least room, and a name that needs a second line has it: one line of a long name says too little.
  const fits =
    plan.width >= CELL.least.width &&
    plan.height >= CELL.least.height &&
    lines >= Math.min(longest, 2);
  const soma = Math.max(somaWith(lines), Math.min(SOMA_R.least, height * 0.2));
  return {
    cell: { width, height, soma, lines, short: longest - lines, small },
    fits,
  };
};

/** Where a block's neurons sit in its band, row by row, every other column a little lower. */
const placeBlock = (
  block: Block,
  band: Band,
  neurons: Neuron[],
  links: number[],
  frame: {
    left: number;
    rowsTop: number;
    before: number;
    lowered: number;
    lift: number;
    cell: Cell;
  }
): void => {
  const { left, rowsTop, before, lowered, lift, cell } = frame;
  const { width, height, soma } = cell;
  const columns = Math.max(columnsOf(block, band.rows), 1);
  const used = Math.ceil(block.own.length / columns);
  for (const [place, index] of block.own.entries()) {
    const neuron = neurons[index];
    if (!neuron) {
      continue;
    }
    const random = seeded(hash(neuron.id) + 3);
    const row = Math.floor(place / columns);
    const column = place % columns;
    // A last row that is not full sits in the middle.
    const inRow =
      row === used - 1 ? block.own.length - columns * (used - 1) : columns;
    const across = (columns - inRow) / 2 + column;
    // Between two columns, as a last row in the middle can be, it sits at the lower level, clear of both names above it.
    const lower = across % 1 !== 0 || (before + across) % 2 === 1;
    neuron.x =
      left + (across + 0.5) * width + (random() - 0.5) * width * UNEVEN * 2;
    neuron.y =
      rowsTop -
      (row + 0.5 + (lower ? lowered : 0)) * height +
      lift +
      (random() - 0.5) * Math.min(height * 0.06, 8);
    // A folder is as large as a soma gets; a note as large as it is linked.
    neuron.r =
      neuron.kind === "cluster"
        ? soma
        : soma * (0.6 + 0.4 * Math.min(1, Math.sqrt(at(links, index)) / 5));
  }
};

/** Open questions against what they are about: up and to the right of it, fanned when it has several. */
const placeOpen = (neurons: Neuron[], soma: number): void => {
  const held = new Map<number, number>();
  for (const neuron of neurons) {
    const subject =
      neuron.beside === undefined ? undefined : neurons[neuron.beside];
    if (neuron.beside === undefined || !subject) {
      continue;
    }
    const order = held.get(neuron.beside) ?? 0;
    held.set(neuron.beside, order + 1);
    const angle = 0.55 + order * 0.85;
    neuron.r = Math.max(soma * 0.36, 4);
    neuron.x = subject.x + Math.cos(angle) * (subject.r + neuron.r * 1.05);
    neuron.y = subject.y + Math.sin(angle) * (subject.r + neuron.r * 1.05);
  }
};

/**
 * Where everything sits, in the room's pixels: the groups in the vault's order in bands, each band
 * hanging from one line with its groups' names over it, each group a block of cells, row by row,
 * with every other column a little lower where there is height for it, so the cells interlock.
 * Groups too small for a name share a block. A cell holds a soma and its name under it, as many
 * lines as its height leaves. An open question sits against the neuron it is about. Gives back the
 * cell, and whether it is large enough to read.
 */
const layOut = (
  neurons: Neuron[],
  groups: Group[],
  links: number[],
  room: MapRoom
): { cell: Cell; fits: boolean } => {
  if (neurons.length === 0) {
    return { cell: emptyCell(), fits: true };
  }
  const blocks = blocksOf(neurons, groups);
  const between = room.width < BETWEEN.from ? BETWEEN.narrow : BETWEEN.wide;
  const plan = arrange(blocks, room);
  const { cell, fits } = cellOf(neurons, plan);
  const { width, height } = cell;
  const line = cell.small ? NAME.small : NAME.line;
  // A soma and its name, together in the middle of their cell: the soma that much over the middle.
  const lift = (cell.lines * line + NAME.around - 6) / 2;

  const stagger =
    staggerAt(height) > plan.stagger ? plan.stagger : staggerAt(height);
  const blockWidth = Math.max(
    ...plan.bands.map(
      (band) => band.columns * width + (band.blocks.length - 1) * between
    )
  );
  const blockHeight =
    plan.bands.reduce(
      (sum, band) =>
        sum +
        band.head +
        (band.used + (band.columns > 1 ? stagger : 0)) * height,
      0
    ) +
    (plan.bands.length - 1) * BAND_GAP;
  // Every band starts at the same left edge, so the groups' names line up; the whole sits in the middle of the room.
  const edge = -blockWidth / 2;
  let top = Math.min(blockHeight, room.height) / 2;
  for (const band of plan.bands) {
    const lowered = band.columns > 1 ? stagger : 0;
    const rowsTop = top - band.head;
    let left = edge;
    // The band's columns run on from one block into the next, so neighbours in two blocks interlock too.
    let before = 0;
    for (const block of band.blocks) {
      const columns = Math.max(columnsOf(block, band.rows), 1);
      placeBlock(block, band, neurons, links, {
        left,
        rowsTop,
        before,
        lowered,
        lift,
        cell,
      });
      for (const group of block.groups) {
        const named = groups[group];
        if (!named) {
          continue;
        }
        named.x = left + 4;
        named.y = rowsTop + (band.head > 0 ? 6 : 0);
        named.width = columns * width - 8;
        if (block.name === 0) {
          named.lines = 0;
        } else {
          named.lines = block.name * HEAD.letter > columns * width - 8 ? 2 : 1;
        }
      }
      left += columns * width + between;
      before += columns;
    }
    top = rowsTop - (band.used + lowered) * height - BAND_GAP;
  }
  placeOpen(neurons, cell.soma);
  return { cell, fits };
};

/** What a map is made of before it is laid out: its neurons and their groups, and which neuron each note is. */
interface Parts {
  region: AtlasRegion;
  neurons: Neuron[];
  groups: Group[];
  neuronOf: Map<string, number>;
}

/** A neuron's state: open where a question is open about it, hollow while it waits, known otherwise. */
const stateOf = (
  id: string,
  open: Set<string>,
  region: AtlasRegion
): NeuronState => {
  if (open.has(id)) {
    return "open";
  }
  return region.waiting.includes(id) ? "waiting" : "known";
};

/** A note's label among its folder's: without the words its folder's titles share, which the folder's name says. */
const labelIn = (
  title: string,
  start: string
): { label: string; title?: string } => {
  const rest =
    start && title.startsWith(`${start} `) ? title.slice(start.length + 1) : "";
  return rest
    ? { label: `${rest.charAt(0).toUpperCase()}${rest.slice(1)}`, title }
    : { label: title };
};

/** The neurons of one folder: one for each note, or one for them all when it holds more than `fold`. */
const addFolder = (
  parts: Parts,
  folder: string,
  members: Note[],
  folderNotes: Map<string, Note>,
  fold: number,
  open: Set<string>
): void => {
  const { region, neurons, groups, neuronOf } = parts;
  const [first] = members;
  const path = first?.path ?? [];
  const own = folderNotes.get(folder);
  // The nearest folder above with a note of its own.
  const above = path
    .slice(0, -1)
    .map((_, depth) => folderNotes.get(path.slice(0, depth + 1).join("/")))
    .findLast(Boolean);
  const group = groups.length;
  groups.push({
    label: folderName(path.at(-1) ?? folder),
    noteId: own?.id,
    parent:
      !own && above ? { label: above.title, noteId: above.id } : undefined,
    x: 0,
    y: 0,
    width: 0,
    lines: 0,
  });
  // A folder with many notes folds into one neuron.
  if (members.length > fold) {
    const many = members.length;
    const waiting = members.every((member) =>
      region.waiting.includes(member.id)
    );
    for (const member of members) {
      neuronOf.set(member.id, neurons.length);
    }
    neurons.push({
      id: `${CLUSTER}${folder}`,
      noteIds: members.map((member) => member.id),
      kind: "cluster",
      label: `${folderName(path.at(-1) ?? folder)} · ${many}`,
      state: waiting ? "waiting" : "known",
      group,
      r: 0,
      x: 0,
      y: 0,
    });
    return;
  }
  // What most of the folder's titles start with is said once, by the folder's name.
  const start = sharedStart(members.map((member) => member.title));
  for (const member of members) {
    neuronOf.set(member.id, neurons.length);
    neurons.push({
      id: member.id,
      noteIds: [member.id],
      kind: member.kind,
      ...labelIn(member.title, start),
      state: stateOf(member.id, open, region),
      group,
      r: 0,
      x: 0,
      y: 0,
    });
  }
};

/** An open question as a small neuron of its own, against the first note here it is about, or the one it was noticed in. */
const addOpen = (
  parts: Parts,
  byId: Map<string, Note>,
  regionId: RegionId,
  link: (a: number, b: number) => void,
  only: string | undefined
): void => {
  const { region, neurons, groups, neuronOf } = parts;
  let loose = -1;
  for (const item of region.open) {
    const note = byId.get(item.noteId);
    if (note?.kind !== "gap" || regionId === "gaps") {
      continue;
    }
    const index = neurons.length;
    const beside = [...item.subjects, ...note.links]
      .map((id) => neuronOf.get(id))
      .find((found) => found !== undefined);
    // Narrowed to one folder, only what is about the notes in it.
    if (beside === undefined && only !== undefined) {
      continue;
    }
    if (beside === undefined && loose < 0) {
      loose = groups.length;
      groups.push({ label: t`Still open`, x: 0, y: 0, width: 0, lines: 0 });
    }
    neurons.push({
      id: item.noteId,
      noteIds: [item.noteId],
      kind: "gap",
      label: item.question,
      state: "open",
      group: beside === undefined ? loose : (neurons[beside]?.group ?? loose),
      beside,
      r: 0,
      x: 0,
      y: 0,
    });
    neuronOf.set(item.noteId, index);
    for (const subject of item.subjects) {
      const found = neuronOf.get(subject);
      if (found !== undefined) {
        link(index, found);
      }
    }
  }
};

/** The notes of a region, folder by folder, as neurons in groups: a folder's own note names its group. */
const partsOf = (
  region: AtlasRegion,
  regionId: RegionId,
  atlas: Atlas,
  byId: Map<string, Note>,
  fold: number,
  only: string | undefined
): { parts: Parts; folderNotes: Map<string, Note> } => {
  const openNotes = new Set(
    region.open
      .filter((item) => byId.get(item.noteId)?.kind !== "gap")
      .flatMap((item) => item.subjects)
  );
  // Among the gaps, the open questions are the gaps' own notes.
  if (regionId === "gaps") {
    for (const item of region.open) {
      openNotes.add(item.noteId);
    }
  }
  const shown = new Set(shownNotes(regionId, atlas));
  // The notes of one folder sit together. A folder's own note names its group rather than being a neuron in it.
  const folders = new Map<string, Note[]>();
  const folderNotes = new Map<string, Note>();
  for (const note of region.notes) {
    const folder = note.path.join("/");
    if (note.kind === "channel") {
      folderNotes.set(folder, note);
    } else if (shown.has(note) && (only === undefined || folder === only)) {
      folders.set(folder, [...(folders.get(folder) ?? []), note]);
    }
  }
  const parts: Parts = { region, neurons: [], groups: [], neuronOf: new Map() };
  for (const [folder, members] of folders) {
    addFolder(parts, folder, members, folderNotes, fold, openNotes);
  }
  return { parts, folderNotes };
};

/** The map with every folder of more than `fold` notes as one neuron; narrowed to one folder, `only`, when there is one. */
const foldedMap = (
  regionId: RegionId,
  atlas: Atlas,
  brain: Brain,
  room: MapRoom,
  fold: number,
  only?: string
): NeuronMap => {
  const region = atlas.regions.find((each) => each.id === regionId);
  if (!region) {
    return {
      region: regionId,
      neurons: [],
      groups: [],
      synapses: [],
      exits: [],
      room,
      cell: emptyCell(),
      fits: true,
    };
  }
  const byId = new Map(brain.notes.map((note) => [note.id, note]));
  const { parts, folderNotes } = partsOf(
    region,
    regionId,
    atlas,
    byId,
    fold,
    only
  );
  const { neurons, groups, neuronOf } = parts;
  // A folder note that names no group here is a neuron after all, in a group of its own; not in a region narrowed to one folder.
  const naming = new Set(
    groups.flatMap((group) => [group.noteId, group.parent?.noteId])
  );
  for (const note of folderNotes.values()) {
    if (naming.has(note.id) || only !== undefined) {
      continue;
    }
    neuronOf.set(note.id, neurons.length);
    neurons.push({
      id: note.id,
      noteIds: [note.id],
      kind: note.kind,
      label: note.title,
      state: "known",
      group: groups.length,
      r: 0,
      x: 0,
      y: 0,
    });
    groups.push({
      label: folderName(note.path.at(-1) ?? note.title),
      x: 0,
      y: 0,
      width: 0,
      lines: 0,
    });
  }

  const synapses = new Map<string, [number, number]>();
  const link = (a: number, b: number) => {
    if (a !== b) {
      const pair: [number, number] = a < b ? [a, b] : [b, a];
      synapses.set(`${pair[0]}:${pair[1]}`, pair);
    }
  };
  addOpen(parts, byId, regionId, link, only);

  const outside = new Map<RegionId, Set<number>>();
  // How many links run to each other region from what is shown, for a region narrowed to one folder.
  const crossing = new Map<RegionId, number>();
  for (const [from, to] of brain.edges) {
    const a = neuronOf.get(from);
    const b = neuronOf.get(to);
    if (a !== undefined && b !== undefined) {
      link(a, b);
      continue;
    }
    const inside = a ?? b;
    if (inside === undefined) {
      continue;
    }
    const other = atlas.home.get(a === undefined ? from : to);
    if (!other || other === regionId) {
      continue;
    }
    outside.set(other, (outside.get(other) ?? new Set()).add(inside));
    crossing.set(other, (crossing.get(other) ?? 0) + 1);
  }
  const pairs = [...synapses.values()];
  const links = neurons.map(
    (_, index) =>
      pairs.filter(([a, b]) => a === index || b === index).length +
      [...outside.values()].filter((set) => set.has(index)).length
  );
  const { cell, fits } = layOut(neurons, groups, links, room);

  // The ways out: each other region this one links to, by name, in the atlas's own order. They sit in a row over the room until the atlas, which knows how wide each name is, puts them where they fit.
  const out = REGION_IDS.filter(
    (other) => outside.has(other) && (region.links[other] ?? 0) > 0
  );
  const step = room.width / Math.max(out.length, 1);
  const exits = out.map((other, index): Exit => ({
    region: other,
    x: (index - (out.length - 1) / 2) * step,
    y: room.height / 2 + EXITS,
    count:
      (only === undefined ? region.links[other] : crossing.get(other)) ?? 0,
    from: [...(outside.get(other) ?? [])].toSorted((a, b) => a - b),
  }));
  return {
    region: regionId,
    neurons,
    groups,
    synapses: pairs,
    exits,
    room,
    cell,
    fits,
  };
};

/**
 * The neurons of a region, folder by folder, their links, and where its links to other regions
 * leave, laid out in the room it has on screen. In a room too small for all of them, its fullest
 * folders become one neuron each, until what is shown fits. Narrowed to one of its groups, it
 * shows every note in it, however small the room.
 */
export const neuronMap = (
  regionId: RegionId,
  atlas: Atlas,
  brain: Brain,
  room: MapRoom,
  group?: string
): NeuronMap => {
  if (group !== undefined) {
    return foldedMap(
      regionId,
      atlas,
      brain,
      room,
      Number.POSITIVE_INFINITY,
      group
    );
  }
  if (shownNotes(regionId, atlas).length > GROUPS_AT) {
    return foldedMap(regionId, atlas, brain, room, 0);
  }
  let map = foldedMap(regionId, atlas, brain, room, CLUSTER_AT);
  for (const fold of FOLDS.slice(1)) {
    if (map.fits) {
      break;
    }
    map = foldedMap(regionId, atlas, brain, room, fold);
  }
  return map;
};

/** The folder a note opens its region to: the one it is folded into when the region is seen in all, so the note is there to see. */
export const folderHolding = (
  regionId: RegionId,
  atlas: Atlas,
  brain: Brain,
  noteId: string
): string | undefined => {
  const cluster = neuronMap(regionId, atlas, brain, MAP_ROOM).neurons.find(
    (neuron) => neuron.kind === "cluster" && neuron.noteIds.includes(noteId)
  );
  return cluster ? clusterFolder(cluster.id) : undefined;
};

/**
 * The names of the ways out, each so many pixels wide, in rows no wider than `room` with `gap`
 * between two names: in order, in as few rows as hold them, and those rows about as full as each
 * other, so a narrow screen gets two even rows rather than a full one and a leftover. A name wider
 * than the room has a row to itself.
 */
export const exitRows = (
  widths: number[],
  room: number,
  gap: number
): number[][] => {
  if (widths.length === 0) {
    return [];
  }
  const fill = (limit: number) => {
    const rows: number[][] = [];
    let row: number[] = [];
    let used = 0;
    for (const [index, width] of widths.entries()) {
      if (row.length > 0 && used + gap + width > limit) {
        rows.push(row);
        row = [index];
        used = width;
      } else {
        used += (row.length > 0 ? gap : 0) + width;
        row.push(index);
      }
    }
    rows.push(row);
    return rows;
  };
  const fewest = fill(room).length;
  // The narrowest rows that are still as few.
  let low = Math.max(...widths);
  let high = Math.max(room, low);
  for (let pass = 0; pass < 14 && high - low > 0.5; pass += 1) {
    const middle = (low + high) / 2;
    if (fill(middle).length <= fewest) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return fill(fill(low).length <= fewest ? low : high);
};

/** What each dot of a figure draws. */
export const SOMA = 0;
export const DENDRITE = 1;
export const SYNAPSE = 2;
export const AXON = 3;
export const SURFACE = 4;

/**
 * Dots as the atlas draws them: where each is in the world (the atlas brain's own units), how it is
 * printed, what it belongs to, and the spacing it was printed at, so dots keep their size on screen
 * whatever the camera does.
 */
export interface AtlasDots {
  x: Float32Array;
  y: Float32Array;
  /** Towards you; and for the brain's surface, the outward normal, so it shades as it turns. */
  z: Float32Array;
  nx: Float32Array;
  ny: Float32Array;
  nz: Float32Array;
  tone: Float32Array;
  ink: Float32Array;
  presence: Float32Array;
  /** On the brain, its region; in a map, its neuron, or for a synapse its first neuron. -1 for none. */
  owner: Int16Array;
  /** For a synapse, its other neuron; for an axon, -2 minus its exit. -1 otherwise. */
  other: Int16Array;
  role: Uint8Array;
  pitch: Float32Array;
  /** How far along its line a dendrite, synapse or axon dot is, 0 to 1, for pulses running along it. */
  along: Float32Array;
}

const emptyDots = (count = atlasCount()): AtlasDots => ({
  x: new Float32Array(count),
  y: new Float32Array(count),
  z: new Float32Array(count),
  nx: new Float32Array(count),
  ny: new Float32Array(count),
  nz: new Float32Array(count),
  tone: new Float32Array(count),
  ink: new Float32Array(count),
  presence: new Float32Array(count),
  owner: new Int16Array(count).fill(-1),
  other: new Int16Array(count).fill(-1),
  role: new Uint8Array(count),
  pitch: new Float32Array(count),
  along: new Float32Array(count),
});

/** The atlas brain as atlas dots, in its own unturned frame: each on the surface, owned by its region, with its normal. */
export const brainDots = (): AtlasDots => {
  const cloud = brainCloud();
  const dots = emptyDots(cloud.count);
  dots.x.set(cloud.x);
  dots.y.set(cloud.y);
  dots.z.set(cloud.z);
  dots.nx.set(cloud.nx);
  dots.ny.set(cloud.ny);
  dots.nz.set(cloud.nz);
  dots.presence.fill(1);
  dots.role.fill(SURFACE);
  dots.pitch.fill(CLOUD_PITCH);
  dots.pitch.fill(SPINE_PITCH, cloud.body);
  // The spine never prints lighter than this, so a vertebra keeps its shape where the light falls on it.
  dots.ink.fill(0.2, cloud.body);
  dots.owner.set(cloud.region);
  return dots;
};

/** Where a map sits in the world: its middle, how far its box's unit reaches, and the zoom it is printed for. */
export interface MapFrame {
  x: number;
  y: number;
  reach: number;
  zoom: number;
}

/** Where the light comes from, as seen: above and to the left, in front. The brain and every neuron are shaded by it. */
export const LIGHT: readonly [number, number, number] = (() => {
  const length = Math.hypot(-0.45, 0.6, 0.66);
  return [-0.45 / length, 0.6 / length, 0.66 / length] as const;
})();

/** A map prints finer than the brain: half its spacing, so a neuron has the detail the brain's surface has. */
const FINE = 0.5;
/** A soma never takes more dots than this, however much room it has. */
const SOMA_DOTS = 720;
/** A soma that is still waiting is hollow: only this much of it, from its rim in, is printed. */
const RIM = 0.34;

/** One line of dots along a curve from one point, bowing through another, to a third: a dendrite, a synapse or an axon. */
interface Strand {
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  x2: number;
  y2: number;
  owner: number;
  other: number;
  role: number;
  /** How bold it is where it starts and where it ends: it tapers. */
  from: number;
  to: number;
  /** A nerve fibre: two strands side by side, beaded, ending in a small terminal. */
  fibre: boolean;
}

/** The point a line between two points bows through: off its middle, sideways, by a share of its length. */
const bowed = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  bow: number
): [number, number] => {
  const length = Math.hypot(x2 - x1, y2 - y1) || 1e-6;
  return [
    (x1 + x2) / 2 - ((y2 - y1) / length) * length * bow,
    (y1 + y2) / 2 + ((x2 - x1) / length) * length * bow,
  ];
};

const strandLength = (strand: Strand): number =>
  Math.hypot(strand.cx - strand.x1, strand.cy - strand.y1) +
  Math.hypot(strand.x2 - strand.cx, strand.y2 - strand.cy);

/** Where a line from a neuron towards a point leaves its soma. */
const edgeOf = (
  neuron: Neuron,
  towardX: number,
  towardY: number
): [number, number] => {
  const angle = Math.atan2(towardY - neuron.y, towardX - neuron.x);
  return [
    neuron.x + Math.cos(angle) * neuron.r,
    neuron.y + Math.sin(angle) * neuron.r,
  ];
};

/** A twig off a dendrite, part of the way along it. */
const twigOf = (
  dendrite: Strand,
  random: () => number,
  angle: number,
  bend: number,
  length: number
): Strand => {
  const { x1, y1, cx, cy, x2, y2 } = dendrite;
  const off = 0.35 + random() * 0.4;
  const tx =
    (1 - off) * (1 - off) * x1 + 2 * off * (1 - off) * cx + off * off * x2;
  const ty =
    (1 - off) * (1 - off) * y1 + 2 * off * (1 - off) * cy + off * off * y2;
  const away =
    angle + bend * off + (random() < 0.5 ? -1 : 1) * (0.5 + random() * 0.5);
  const reach = length * (0.3 + random() * 0.35);
  const ex = tx + Math.cos(away) * reach;
  const ey = ty + Math.sin(away) * reach;
  const [bx, by] = bowed(tx, ty, ex, ey, (random() - 0.5) * 0.6);
  return {
    x1: tx,
    y1: ty,
    cx: bx,
    cy: by,
    x2: ex,
    y2: ey,
    owner: dendrite.owner,
    other: -1,
    role: DENDRITE,
    from: 0.5,
    to: 0.08,
    fibre: false,
  };
};

/** A neuron's dendrites: the first one up and longer, the apical dendrite; the rest round the soma; a twig or two off each. */
const dendritesOf = (neuron: Neuron, index: number): Strand[] => {
  const strands: Strand[] = [];
  const random = seeded(hash(neuron.id));
  const isGap = neuron.kind === "gap";
  const branches = isGap ? 3 : 4 + Math.floor(random() * 3);
  for (let branch = 0; branch < branches; branch += 1) {
    const apical = branch === 0 && !isGap;
    const angle = apical
      ? Math.PI / 2 + (random() - 0.5) * 0.5
      : (branch / branches) * Math.PI * 2 +
        Math.PI / 2 +
        (random() - 0.5) * 0.8;
    const length =
      neuron.r * (apical ? 1.25 + random() * 0.5 : 0.6 + random() * 0.7);
    const bend = (random() - 0.5) * (apical ? 0.5 : 1.1);
    const x1 = neuron.x + Math.cos(angle) * neuron.r * 0.96;
    const y1 = neuron.y + Math.sin(angle) * neuron.r * 0.96;
    const x2 = neuron.x + Math.cos(angle + bend) * (neuron.r + length);
    const y2 = neuron.y + Math.sin(angle + bend) * (neuron.r + length);
    const [cx, cy] = bowed(x1, y1, x2, y2, (random() - 0.5) * 0.5);
    const dendrite: Strand = {
      x1,
      y1,
      cx,
      cy,
      x2,
      y2,
      owner: index,
      other: -1,
      role: DENDRITE,
      from: 0.9,
      to: 0.1,
      fibre: false,
    };
    strands.push(dendrite);
    // A twig or two off each branch, part of the way along.
    const twigs = isGap ? 0 : 1 + Math.floor(random() * 2);
    for (let twig = 0; twig < twigs; twig += 1) {
      strands.push(twigOf(dendrite, random, angle, bend, length));
    }
  }
  return strands;
};

/** Every strand of a map: dendrites, then synapses between neurons, then axons out to other regions. */
const strandsOf = (map: NeuronMap, step: number): Strand[] => {
  const strands = map.neurons.flatMap((neuron, index) =>
    dendritesOf(neuron, index)
  );
  for (const [a, b] of map.synapses) {
    const one = map.neurons[a];
    const two = map.neurons[b];
    if (!one || !two) {
      continue;
    }
    const [x1, y1] = edgeOf(one, two.x, two.y);
    const [x2, y2] = edgeOf(two, one.x, one.y);
    // An open question lies against its note: nothing to draw between them.
    if (Math.hypot(x2 - x1, y2 - y1) < step * 3) {
      continue;
    }
    const [cx, cy] = bowed(
      x1,
      y1,
      x2,
      y2,
      (hash(`${one.id}${two.id}`) % 2 === 0 ? 1 : -1) * 0.14
    );
    strands.push({
      x1,
      y1,
      cx,
      cy,
      x2,
      y2,
      owner: a,
      other: b,
      role: SYNAPSE,
      from: 0.6,
      to: 0.45,
      fibre: true,
    });
  }
  for (const [exit, out] of map.exits.entries()) {
    for (const from of out.from) {
      const neuron = map.neurons[from];
      if (!neuron) {
        continue;
      }
      const [x1, y1] = edgeOf(neuron, out.x, out.y);
      const [cx, cy] = bowed(
        x1,
        y1,
        out.x,
        out.y,
        (hash(`${neuron.id}${out.region}`) % 2 === 0 ? 1 : -1) * 0.1
      );
      strands.push({
        x1,
        y1,
        cx,
        cy,
        x2: out.x,
        y2: out.y,
        owner: from,
        other: -2 - exit,
        role: AXON,
        from: 0.55,
        to: 0.3,
        fibre: true,
      });
    }
  }
  return strands;
};

/** Puts one dot, in the map's pixels, where it belongs in the world. */
type Put = (
  x: number,
  y: number,
  ink: number,
  tone: number,
  owner: number,
  other: number,
  role: number,
  along?: number
) => void;

/** Somas: the half of a sphere that faces you, dots spread evenly over it, so they gather at the rim as on a ball, and shaded as print. */
const printSoma = (
  neuron: Neuron,
  index: number,
  many: number,
  put: Put
): void => {
  const random = seeded(hash(neuron.id) + 7);
  const lean = random() * Math.PI * 2;
  const sway = random() * Math.PI * 2;
  // Still waiting: hollow, only its rim.
  const printed = neuron.state === "waiting" ? Math.round(many * RIM) : many;
  for (let dot = 0; dot < printed; dot += 1) {
    const nz = (dot + 0.5) / many;
    const ring = Math.sqrt(1 - nz * nz);
    const angle = dot * 2.399963;
    const nx = Math.cos(angle) * ring;
    const ny = Math.sin(angle) * ring;
    // A cell is not a perfect ball: its outline swells and dips a little.
    const uneven =
      1 + 0.07 * Math.sin(3 * angle + lean) + 0.04 * Math.sin(5 * angle + sway);
    const light = Math.max(nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2], 0);
    const towards = Math.sqrt(nz);
    put(
      neuron.x + nx * neuron.r * uneven,
      neuron.y + ny * neuron.r * uneven,
      (0.08 + 0.92 * (1 - light) ** 1.4) * (0.5 + 0.5 * towards),
      (0.25 + 0.75 * light) * (0.3 + 0.7 * towards),
      index,
      -1,
      SOMA
    );
  }
};

/** Strands: dendrites taper to nothing; fibres run as two beaded strands and end in a small terminal. */
const printStrand = (
  strand: Strand,
  step: number,
  coarser: number,
  put: Put
): void => {
  const length = strandLength(strand);
  const many = Math.max(3, Math.round(length / (step * 0.8 * coarser)));
  const dx = strand.x2 - strand.x1;
  const dy = strand.y2 - strand.y1;
  const across = Math.hypot(dx, dy) || 1e-6;
  const { owner, other, role } = strand;
  for (let dot = 1; dot <= many; dot += 1) {
    const along = dot / many;
    const x =
      (1 - along) * (1 - along) * strand.x1 +
      2 * along * (1 - along) * strand.cx +
      along * along * strand.x2;
    const y =
      (1 - along) * (1 - along) * strand.y1 +
      2 * along * (1 - along) * strand.cy +
      along * along * strand.y2;
    const bold = strand.from + (strand.to - strand.from) * along;
    if (!strand.fibre) {
      put(x, y, bold, 0.6, owner, other, role, along);
      continue;
    }
    // Beaded, as a myelinated fibre is; the second strand runs beside the first, fainter.
    const bead = 0.75 + 0.25 * Math.sin(dot * 1.1);
    put(x, y, bold * bead, 0.55, owner, other, role, along);
    put(
      x - (dy / across) * step * 1.15,
      y + (dx / across) * step * 1.15,
      bold * 0.55,
      0.5,
      owner,
      other,
      role,
      along
    );
  }
  if (strand.fibre) {
    // The terminal: a small bud where the fibre arrives.
    put(strand.x2, strand.y2, 0.9, 0.6, owner, other, role, 1);
    for (let bud = 0; bud < 6; bud += 1) {
      put(
        strand.x2 + Math.cos(bud * 1.047) * step * 1.3,
        strand.y2 + Math.sin(bud * 1.047) * step * 1.3,
        0.6,
        0.55,
        owner,
        other,
        role,
        1
      );
    }
  }
};

/**
 * A map as atlas dots, placed by `frame`, printed as the brain is: every soma a small sphere of fine
 * dots, shaded by the same light, its outline a little uneven as a cell's is, and hollow while its
 * note is still waiting; dendrites branching off it and tapering, the first one up, as in cortex;
 * synapses and axons as nerve fibres, two beaded strands side by side that end in a small
 * terminal. As fine as the figure's points allow: a crowded region prints a little coarser.
 * Unused points wait unseen on used ones.
 */
export const mapDots = (map: NeuronMap, frame: MapFrame): AtlasDots => {
  const count = atlasCount();
  const dots = emptyDots(count);
  const pitch = (CLOUD_PITCH / frame.zoom) * FINE;
  const step = pitch / frame.reach;
  let used = 0;
  // The groups' names stand over the canvas: a dendrite or a fibre that runs under one leaves it clear, so the name stays easy to read.
  const names = map.groups
    .filter((group) => group.lines > 0)
    .map((group) => ({
      left: group.x - 4,
      right:
        group.x + Math.min(group.width, group.label.length * HEAD.letter) + 4,
      bottom: group.y - 3,
      top: group.y + group.lines * HEAD.line + 3,
    }));
  const put: Put = (x, y, ink, tone, owner, other, role, along = 0) => {
    if (used >= count) {
      return;
    }
    if (
      role !== SOMA &&
      names.some(
        (name) =>
          x > name.left && x < name.right && y > name.bottom && y < name.top
      )
    ) {
      return;
    }
    dots.along[used] = along;
    dots.x[used] = frame.x + x * frame.reach;
    dots.y[used] = frame.y + y * frame.reach;
    dots.ink[used] = ink;
    dots.tone[used] = tone;
    dots.presence[used] = 1;
    dots.owner[used] = owner;
    dots.other[used] = other;
    dots.role[used] = role;
    dots.pitch[used] = pitch;
    used += 1;
  };

  // Every strand first, so the budget can be shared before anything is printed.
  const strands = strandsOf(map, step);

  // The budget: somas take up to half the points, strands the rest; when it is tight, both print a little coarser.
  const somaWants = map.neurons.map((neuron) =>
    Math.min(
      SOMA_DOTS,
      Math.round(((2 * Math.PI * neuron.r * neuron.r) / (step * step)) * 0.8)
    )
  );
  const somaShare = Math.min(
    1,
    (count * 0.5) /
      Math.max(
        somaWants.reduce((sum, each) => sum + each, 0),
        1
      )
  );
  const strandWants = strands.reduce(
    (sum, strand) =>
      sum +
      (strandLength(strand) / (step * 0.8)) * (strand.fibre ? 2 : 1) +
      (strand.fibre ? 7 : 0),
    0
  );
  const somaTotal = somaWants.reduce(
    (sum, each) => sum + Math.round(each * somaShare),
    0
  );
  const coarser = Math.max(
    1,
    strandWants / Math.max((count - somaTotal) * 0.94, 1)
  );

  for (const [index, neuron] of map.neurons.entries()) {
    const many = Math.max(24, Math.round(at(somaWants, index) * somaShare));
    printSoma(neuron, index, many, put);
  }
  for (const strand of strands) {
    printStrand(strand, step, coarser, put);
  }
  // Points the map does not need wait unseen on the ones it does, so they flow in from somewhere.
  for (let index = used; index < count; index += 1) {
    const source = used > 0 ? index % used : 0;
    dots.x[index] = at(dots.x, source);
    dots.y[index] = at(dots.y, source);
    dots.pitch[index] = pitch;
  }
  return dots;
};

/** How high a dot sits, with a little unevenness, so the edge of what is filled is not ruled. */
const levelOf = (dots: AtlasDots, index: number): number =>
  at(dots.y, index) +
  0.03 * Math.sin(at(dots.x, index) * 11 + at(dots.z, index) * 8);

/** The dots of one half of a region on the brain: a lobe's half, or the whole of the cerebellum or the stem. Never down the spine, where it could be out of view. */
const seenDots = (
  dots: AtlasDots,
  body: number,
  index: number,
  half: number
): number[] => {
  const seen: number[] = [];
  for (let dot = 0; dot < body; dot += 1) {
    const onHalf = index >= 4 || (half === 0) === at(dots.x, dot) >= 0;
    if (
      at(dots.owner, dot) === index &&
      at(dots.presence, dot) === 1 &&
      onHalf
    ) {
      seen.push(dot);
    }
  }
  return seen;
};

/** A patch of dots in the attention colour for each open question, where it belongs in its region, the same place every time. */
const markOpen = (
  marks: Uint8Array,
  dots: AtlasDots,
  seen: number[],
  region: AtlasRegion,
  atlas: Atlas,
  half: number
): void => {
  for (const item of region.open) {
    const subjects = item.subjects.filter(
      (subject) => atlas.home.get(subject) === region.id
    );
    for (const subject of subjects.length > 0 ? subjects : [item.id]) {
      const anchor =
        seen[hash(`${item.id}:${subject}:${half}`) % seen.length] ?? 0;
      const ax = at(dots.x, anchor);
      const ay = at(dots.y, anchor);
      const az = at(dots.z, anchor);
      const distance = (dot: number) =>
        (at(dots.x, dot) - ax) ** 2 +
        (at(dots.y, dot) - ay) ** 2 +
        (at(dots.z, dot) - az) ** 2;
      for (const dot of seen
        .toSorted((a, b) => distance(a) - distance(b))
        .slice(0, 26)) {
        marks[dot] = OPEN_MARK;
      }
    }
  }
};

/**
 * How each dot of the atlas brain shows what its region holds: as much of the region as its notes
 * are still waiting is left hollow, from its top down, the same on both halves; and for every
 * open question a patch of dots in the attention colour, where it belongs in that region, the
 * same place every time.
 */
export const brainMarks = (dots: AtlasDots, atlas: Atlas): Uint8Array => {
  const count = dots.x.length;
  const body = atlasBody();
  const marks = new Uint8Array(count);
  for (const [index, region] of atlas.regions.entries()) {
    const counted = region.notes.filter(
      (note) => note.kind !== "gap" && note.kind !== "channel"
    ).length;
    const share = counted > 0 ? region.waiting.length / counted : 0;
    // A lobe has two halves: each shows the same, so it shows whichever way the brain is turned.
    for (const half of index < 4 ? [0, 1] : [0]) {
      const seen = seenDots(dots, body, index, half);
      if (seen.length === 0) {
        continue;
      }
      const hollow = Math.round(seen.length * share);
      if (hollow > 0) {
        for (const dot of seen
          .toSorted((a, b) => levelOf(dots, b) - levelOf(dots, a))
          .slice(0, hollow)) {
          marks[dot] = WAITING;
        }
      }
      markOpen(marks, dots, seen, region, atlas, half);
    }
  }
  return marks;
};

/** How each dot of a map shows its neuron: the soma and dendrites of a waiting or open note hollow and pale, or in the attention colour. */
export const mapMarks = (dots: AtlasDots, map: NeuronMap): Uint8Array => {
  const marks = new Uint8Array(dots.x.length);
  for (let dot = 0; dot < dots.x.length; dot += 1) {
    const role = at(dots.role, dot);
    if (role !== SOMA && role !== DENDRITE) {
      continue;
    }
    const state = map.neurons[at(dots.owner, dot)]?.state;
    if (state === "open") {
      marks[dot] = OPEN_MARK;
    } else if (state === "waiting") {
      marks[dot] = WAITING;
    } else {
      marks[dot] = KNOWN;
    }
  }
  return marks;
};
