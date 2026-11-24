// The sums behind the chart parts, pure, so they are tested without a page or the StyleX compiler
// (scripts/chart-layout.test.ts): where a dither's bands start and end, where names set beside
// each other stand, where a tooltip stands, the bars across of ChartBarList, the arcs of ChartPie,
// the line of ChartSparkline, and the layout of ChartSankey. Positions are the drawing's own, in
// CSS pixels; angles are in radians, from twelve o'clock, clockwise.
import { DITHER_LEVELS, ownValue } from "../lib/utils";

// ---- Dither --------------------------------------------------------------------------------

/**
 * The DITHER_LEVELS + 1 edges of a fill from `lit` (the value, most lit) to `floor` (least lit),
 * either way round: `lit` may stand above, below, left or right of `floor`. The first and last are
 * exact; the rest snap to the pitch, so each inner edge sits on a cell's edge in the drawing's own
 * grid, no cell is cut in half and no seam shows where two levels meet.
 */
export const ditherEdges = (
  lit: number,
  floor: number,
  pitch: number
): number[] =>
  Array.from({ length: DITHER_LEVELS + 1 }, (_, index) => {
    if (index === 0) {
      return lit;
    }
    if (index === DITHER_LEVELS) {
      return floor;
    }
    return (
      Math.round((lit + (index * (floor - lit)) / DITHER_LEVELS) / pitch) *
      pitch
    );
  });

// ---- Names beside each other ---------------------------------------------------------------

/**
 * Where each name stands, in the order given: as near `want` as it can be, at least `gap` from its
 * neighbours, between `from` and `to`. When the room is too small for all of them, they share it
 * evenly from `from`.
 */
export const spread = (
  want: readonly number[],
  gap: number,
  from: number,
  to: number
): number[] => {
  const order = want
    .map((place, index) => ({ place, index }))
    .toSorted((a, b) => a.place - b.place);
  const placed = order.map((item) => Math.min(Math.max(item.place, from), to));
  // Down: each at least a gap after the one before.
  for (let index = 1; index < placed.length; index += 1) {
    placed[index] = Math.max(
      placed[index] ?? 0,
      (placed[index - 1] ?? 0) + gap
    );
  }
  // Up: the last inside the room, each at least a gap before the one after.
  const last = placed.length - 1;
  if (last >= 0) {
    placed[last] = Math.min(placed[last] ?? 0, to);
  }
  for (let index = last - 1; index >= 0; index -= 1) {
    placed[index] = Math.min(
      placed[index] ?? 0,
      (placed[index + 1] ?? 0) - gap
    );
  }
  // Too many for the room: evenly from the start.
  if ((placed[0] ?? from) < from) {
    for (const [index] of placed.entries()) {
      placed[index] = from + index * gap;
    }
  }
  const out: number[] = Array.from({ length: want.length }, () => 0);
  for (const [rank, item] of order.entries()) {
    out[item.index] = placed[rank] ?? item.place;
  }
  return out;
};

// ---- Tooltip -------------------------------------------------------------------------------

/**
 * The tooltip's top: `marks` are the hovered points' heights, `plot` the plot's top and height,
 * `height` the tooltip's own, and `gap` the clear room it keeps from every mark.
 */
export const tooltipTop = (
  marks: readonly number[],
  plot: { y: number; height: number },
  height: number,
  gap: number
): number | undefined => {
  if (marks.length === 0) {
    return undefined;
  }
  const highest = Math.min(...marks);
  const lowest = Math.max(...marks);
  const floor = plot.y + plot.height;
  const above = highest - gap - height;
  if (above >= plot.y) {
    return above;
  }
  const below = lowest + gap;
  if (below + height <= floor) {
    return below;
  }
  // No room clear of every mark: the taller side, held inside the plot.
  const up = highest - plot.y;
  const down = floor - lowest;
  return up >= down ? Math.max(plot.y, above) : Math.min(floor - height, below);
};

/**
 * Where a tooltip over bars stands across: centred above its bar when it stands above it, else
 * beside the bar's band (`band` wide round `x`), `gap` off it, on the side with room.
 */
export const barTooltipLeft = (
  x: number,
  band: number,
  width: number,
  plot: { x: number; width: number },
  gap: number,
  above: boolean
): number => {
  if (above) {
    return Math.min(
      Math.max(plot.x, x - width / 2),
      plot.x + plot.width - width
    );
  }
  const right = x + band / 2 + gap;
  return right + width <= plot.x + plot.width
    ? right
    : x - band / 2 - gap - width;
};

// ---- Bars across (ChartBarList) ------------------------------------------------------------

type Row = Readonly<Record<string, string | number>>;

/** A row's value for a key, as a number: anything that is not one is nothing. */
export const valueOf = (row: Row, key: string): number => {
  const value = ownValue(row, key);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

/** The rows, largest first by the first series (`descending`), or as given (`none`). A copy: the data is not changed. */
export const orderRows = <T extends Row>(
  rows: readonly T[],
  key: string,
  sortOrder: "descending" | "none"
): T[] =>
  sortOrder === "none"
    ? [...rows]
    : rows.toSorted((a, b) => valueOf(b, key) - valueOf(a, key));

/** The least and the most of every value, with zero always inside, so every bar starts at zero. */
export const extentOf = (
  rows: readonly Row[],
  keys: readonly string[]
): { min: number; max: number } => {
  const values = rows.flatMap((row) => keys.map((key) => valueOf(row, key)));
  return { min: Math.min(0, ...values), max: Math.max(0, ...values) };
};

/** A bar on a track `width` wide: where it starts, how wide it is, where zero is and which end is its tip. */
export interface Span {
  x: number;
  width: number;
  zero: number;
  /** Whether the tip (the value's end) is on the right: false for a value below zero. */
  rightward: boolean;
}

export const spanOf = (
  value: number,
  extent: { min: number; max: number },
  width: number
): Span => {
  const range = extent.max - extent.min;
  if (range <= 0 || width <= 0) {
    return { x: 0, width: 0, zero: 0, rightward: true };
  }
  const zero = (-extent.min / range) * width;
  const length = (Math.abs(value) / range) * width;
  return value >= 0
    ? { x: zero, width: length, zero, rightward: true }
    : { x: zero - length, width: length, zero, rightward: false };
};

/**
 * A bar's outline: square where it starts, its two corners at the tip rounded by `corner` (less
 * when the bar is too short or thin for it), as an SVG path.
 */
export const barPath = (
  span: Span,
  y: number,
  height: number,
  corner: number
): string => {
  const { x, width, rightward } = span;
  const r = Math.max(0, Math.min(corner, width, height / 2));
  const right = x + width;
  const bottom = y + height;
  if (rightward) {
    return `M${x},${y}H${right - r}A${r},${r} 0 0 1 ${right},${y + r}V${bottom - r}A${r},${r} 0 0 1 ${right - r},${bottom}H${x}Z`;
  }
  return `M${right},${y}V${bottom}H${x + r}A${r},${r} 0 0 1 ${x},${bottom - r}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}Z`;
};

// ---- Pie (ChartPie) ------------------------------------------------------------------------

export interface Arc {
  /** Where it starts and ends, gaps taken out. */
  from: number;
  to: number;
  /** The middle of its share, for its name and its lift. */
  middle: number;
  /** Its share of the whole, 0 to 1. */
  share: number;
}

const TURN = Math.PI * 2;

/**
 * The arcs of `values` round a ring, in order, out of `whole` (their sum unless a larger whole is
 * given, as for a single share). A clear gap of `gap` radians stands between each two, and
 * between the last and the empty track; an arc too thin for its gap keeps a sliver.
 */
export const arcsOf = (
  values: readonly number[],
  gap: number,
  whole?: number
): Arc[] => {
  const sum = values.reduce((total, value) => total + Math.max(0, value), 0);
  const of = Math.max(sum, whole ?? 0);
  if (of <= 0) {
    return values.map(() => ({ from: 0, to: 0, middle: 0, share: 0 }));
  }
  const parts = values.length + (of > sum ? 1 : 0);
  const half = parts > 1 ? gap / 2 : 0;
  let start = 0;
  return values.map((value) => {
    const share = Math.max(0, value) / of;
    const sweep = share * TURN;
    const end = start + sweep;
    const pad = Math.min(half, sweep / 2 - 0.0005);
    const arc = {
      from: start + Math.max(0, pad),
      to: end - Math.max(0, pad),
      middle: start + sweep / 2,
      share,
    };
    start = end;
    return arc;
  });
};

/** The empty track after the arcs, when a whole larger than their sum is given. */
export const restOf = (
  arcs: readonly Arc[],
  gap: number
): { from: number; to: number } | null => {
  const used = arcs.reduce((total, arc) => total + arc.share, 0);
  if (used >= 0.9999) {
    return null;
  }
  return { from: used * TURN + gap / 2, to: TURN - gap / 2 };
};

/** A point at `radius` and `angle` round (`cx`, `cy`). */
export const pointAt = (
  cx: number,
  cy: number,
  radius: number,
  angle: number
) => ({
  x: cx + radius * Math.sin(angle),
  y: cy - radius * Math.cos(angle),
});

const fixed = (value: number) => Math.round(value * 100) / 100;

/** The outline of a ring's arc, from `outer` to `inner` radius, as an SVG path. */
export const arcPath = (
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  from: number,
  to: number
): string => {
  const sweep = to - from;
  if (sweep <= 0) {
    return "";
  }
  // A whole turn is drawn as two halves: an arc cannot start and end at one point.
  if (sweep >= TURN - 0.0001) {
    return `${arcPath(cx, cy, outer, inner, 0, Math.PI)}${arcPath(cx, cy, outer, inner, Math.PI, TURN)}`;
  }
  const large = sweep > Math.PI ? 1 : 0;
  const a = pointAt(cx, cy, outer, from);
  const b = pointAt(cx, cy, outer, to);
  const c = pointAt(cx, cy, inner, to);
  const d = pointAt(cx, cy, inner, from);
  return `M${fixed(a.x)},${fixed(a.y)}A${outer},${outer} 0 ${large} 1 ${fixed(b.x)},${fixed(b.y)}L${fixed(c.x)},${fixed(c.y)}A${inner},${inner} 0 ${large} 0 ${fixed(d.x)},${fixed(d.y)}Z`;
};

// ---- Sparkline (ChartSparkline) ------------------------------------------------------------

/** The drawing's width in its own units: x runs 0 to 100, whatever its box. */
export const SPAN = 100;

export interface SparkPoint {
  x: number;
  y: number;
}

export interface SparkShape {
  points: SparkPoint[];
  /** Where zero stands, when the series crosses it; else null and no zero line is drawn. */
  zero: number | null;
  /** The floor an area under the line fills down to: the drawing's foot, under every segment. */
  floor: number;
  /** The highest point's height, where an area's fade starts. */
  top: number;
}

const finite = (values: readonly number[]) =>
  values.filter((value) => Number.isFinite(value));

/**
 * Each value's place, from `pad` to `height - pad` down the drawing, the highest at the top. One
 * value, or all alike, draw a straight line across the middle: never an error.
 */
export const sparkShape = (
  values: readonly number[],
  height: number,
  pad: number
): SparkShape => {
  const shown = finite(values);
  const middle = height / 2;
  if (shown.length === 0) {
    return { points: [], zero: null, floor: height, top: height };
  }
  const min = Math.min(...shown);
  const max = Math.max(...shown);
  // A wobble of a few per cent is drawn as one: the drawn range is at least a sixth of the largest
  // value's size, centred on the values, so 31, 32, 31 reads nearly flat and not as a zigzag.
  const least = Math.max(Math.abs(min), Math.abs(max)) / 6;
  const range = Math.max(max - min, least);
  const top = (max + min) / 2 + range / 2;
  const yOf = (value: number) =>
    max === min ? middle : pad + ((top - value) / range) * (height - 2 * pad);
  const points =
    shown.length === 1
      ? [
          { x: 0, y: middle },
          { x: SPAN, y: middle },
        ]
      : shown.map((value, index) => ({
          x: (index / (shown.length - 1)) * SPAN,
          y: yOf(value),
        }));
  const crosses = min < 0 && max > 0;
  // A level line on a whole pixel and a half, so its one pixel is sharp.
  const zero = crosses ? Math.round(yOf(0)) + 0.5 : null;
  return {
    points,
    zero,
    floor: height,
    top: Math.min(...points.map((point) => point.y)),
  };
};

const round = (value: number) => Math.round(value * 100) / 100;

/** The line through the points, as an SVG path. */
export const linePath = (points: readonly SparkPoint[]): string =>
  points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${round(point.x)},${round(point.y)}`
    )
    .join("");

/** The area under the line down to `floor`, as an SVG path. */
export const areaPath = (
  points: readonly SparkPoint[],
  floor: number
): string => {
  const first = points.at(0);
  const last = points.at(-1);
  if (first === undefined || last === undefined) {
    return "";
  }
  return `${linePath(points)}L${round(last.x)},${round(floor)}L${round(first.x)},${round(floor)}Z`;
};

/** The one point a spark marks, if any: the last, the lowest or the highest (the first of equals). */
export const markOf = (
  values: readonly number[],
  mark: "last" | "min" | "max" | "none"
): number | null => {
  const shown = finite(values);
  if (mark === "none" || shown.length === 0) {
    return null;
  }
  if (mark === "last") {
    return shown.length - 1;
  }
  const target = mark === "min" ? Math.min(...shown) : Math.max(...shown);
  return shown.indexOf(target);
};

/** The point nearest a place across the drawing, 0 to 1, for a pointer over it. */
export const nearestOf = (count: number, across: number): number =>
  count <= 1
    ? 0
    : Math.min(count - 1, Math.max(0, Math.round(across * (count - 1))));

// ---- Sankey (ChartSankey) ------------------------------------------------------------------

/** One node of a Sankey: a stage, or an end of one. */
export interface ChartSankeyNode {
  /** How links name it. */
  id: string;
  /** Its name, as it is read beside it. */
  label: string;
  /** An end that is not the hoped-for one (disputed, waiting): drawn muted. */
  muted?: boolean;
}

/** One flow of a Sankey, from its `source` node to its `target`, by their ids. */
export interface ChartSankeyLink {
  source: string;
  target: string;
  value: number;
}

export interface PlacedNode extends ChartSankeyNode {
  column: number;
  value: number;
  x: number;
  y: number;
  height: number;
}

export interface PlacedLink extends ChartSankeyLink {
  index: number;
  /** Where it leaves its source and reaches its target: the top edge. */
  sy: number;
  ty: number;
  /** Its thickness. */
  width: number;
  /** The right edge of its source, the left edge of its target. */
  x0: number;
  x1: number;
}

export interface SankeyLayout {
  nodes: PlacedNode[];
  links: PlacedLink[];
  columns: number;
}

/** The box it is laid out in, and its spacing, in CSS pixels. */
export interface SankeyBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  nodeWidth: number;
  padding: number;
}

/**
 * Each node's column: the longest path from a start. An end stays where it is reached (a disputed
 * invoice ends beside approved), so no ribbon runs behind a node to reach the last column.
 */
export const columnsOf = (
  nodes: readonly ChartSankeyNode[],
  links: readonly ChartSankeyLink[]
): Map<string, number> => {
  const depth = new Map(nodes.map((node) => [node.id, 0]));
  // One pass along every link: a node takes one more than any source before it. Repeated until
  // nothing moves, as many times as there are nodes at most, so a loop in the data cannot hang it.
  const relax = () => {
    let moved = false;
    for (const link of links) {
      const next = (depth.get(link.source) ?? 0) + 1;
      if (
        depth.has(link.target) &&
        next > (depth.get(link.target) ?? 0) &&
        next < nodes.length
      ) {
        depth.set(link.target, next);
        moved = true;
      }
    }
    return moved;
  };
  let passes = 0;
  while (passes < nodes.length && relax()) {
    passes += 1;
  }
  return depth;
};

/** How much passes through each node: the more of what comes in and what goes out. */
export const valuesOf = (
  nodes: readonly ChartSankeyNode[],
  links: readonly ChartSankeyLink[]
): Map<string, number> =>
  new Map(
    nodes.map((node) => {
      const into = links
        .filter((link) => link.target === node.id)
        .reduce((sum, link) => sum + link.value, 0);
      const out = links
        .filter((link) => link.source === node.id)
        .reduce((sum, link) => sum + link.value, 0);
      return [node.id, Math.max(into, out)];
    })
  );

/** The weighted middle of a node's neighbours on one side, or null when it has none there. */
const middleOf = (
  id: string,
  links: readonly ChartSankeyLink[],
  centre: Map<string, number>,
  side: "source" | "target"
): number | null => {
  const near = links.filter(
    (link) => (side === "source" ? link.target : link.source) === id
  );
  const weight = near.reduce((sum, link) => sum + link.value, 0);
  if (weight <= 0) {
    return null;
  }
  return (
    near.reduce(
      (sum, link) =>
        sum +
        (centre.get(side === "source" ? link.source : link.target) ?? 0) *
          link.value,
      0
    ) / weight
  );
};

/** Stacks a column's nodes from the top in their order, with padding, the block centred in the room. */
const stack = (column: readonly PlacedNode[], box: SankeyBox) => {
  const used =
    column.reduce((sum, node) => sum + node.height, 0) +
    box.padding * Math.max(0, column.length - 1);
  let y = box.top + Math.max(0, (box.bottom - box.top - used) / 2);
  for (const node of column) {
    node.y = y;
    y += node.height + box.padding;
  }
};

/** How many pairs of links cross between two columns, for the given order. */
export const crossings = (
  links: readonly PlacedLink[] | readonly ChartSankeyLink[],
  rank: Map<string, number>,
  column: Map<string, number>
): number => {
  let count = 0;
  for (const [index, a] of links.entries()) {
    for (const b of links.slice(index + 1)) {
      const same =
        column.get(a.source) === column.get(b.source) &&
        column.get(a.target) === column.get(b.target);
      const out = (rank.get(a.source) ?? 0) - (rank.get(b.source) ?? 0);
      const into = (rank.get(a.target) ?? 0) - (rank.get(b.target) ?? 0);
      if (same && out * into < 0) {
        count += 1;
      }
    }
  }
  return count;
};

/** Orders each column by the weighted middle of its neighbours, sweeping right then left. */
const order = (
  columns: PlacedNode[][],
  links: readonly ChartSankeyLink[],
  box: SankeyBox,
  sweeps: number
) => {
  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    const rightward = sweep % 2 === 0;
    const sequence = rightward
      ? columns.slice(1)
      : columns.slice(0, -1).toReversed();
    for (const column of sequence) {
      const centre = new Map(
        columns.flat().map((node) => [node.id, node.y + node.height / 2])
      );
      const keyed = column.map((node, place) => ({
        node,
        place,
        at:
          middleOf(node.id, links, centre, rightward ? "source" : "target") ??
          centre.get(node.id) ??
          0,
      }));
      const sorted = keyed
        .toSorted((a, b) => a.at - b.at || a.place - b.place)
        .map((item) => item.node);
      column.splice(0, column.length, ...sorted);
      stack(column, box);
    }
  }
};

/** Where each link leaves its source and reaches its target, in the order of the far ends, so links do not cross at a node. */
const attach = (
  nodes: readonly PlacedNode[],
  links: readonly ChartSankeyLink[],
  scale: number,
  box: SankeyBox
): PlacedLink[] => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const placed: PlacedLink[] = links.map((link, index) => {
    const source = byId.get(link.source);
    const target = byId.get(link.target);
    return {
      ...link,
      index,
      sy: 0,
      ty: 0,
      width: link.value * scale,
      x0: (source?.x ?? 0) + box.nodeWidth,
      x1: target?.x ?? 0,
    };
  });
  const centreOf = (id: string) => {
    const node = byId.get(id);
    return node === undefined ? 0 : node.y + node.height / 2;
  };
  for (const node of nodes) {
    let out = node.y;
    for (const link of placed
      .filter((each) => each.source === node.id)
      .toSorted((a, b) => centreOf(a.target) - centreOf(b.target))) {
      link.sy = out;
      out += link.width;
    }
    let into = node.y;
    for (const link of placed
      .filter((each) => each.target === node.id)
      .toSorted((a, b) => centreOf(a.source) - centreOf(b.source))) {
      link.ty = into;
      into += link.width;
    }
  }
  return placed;
};

/** Lays out the nodes and links in the box. */
export const layoutSankey = (
  nodes: readonly ChartSankeyNode[],
  links: readonly ChartSankeyLink[],
  box: SankeyBox,
  sweeps = 6
): SankeyLayout => {
  const known = new Set(nodes.map((node) => node.id));
  const kept = links.filter(
    (link) =>
      link.value > 0 &&
      known.has(link.source) &&
      known.has(link.target) &&
      link.source !== link.target
  );
  const column = columnsOf(nodes, kept);
  const value = valuesOf(nodes, kept);
  const count = Math.max(0, ...column.values()) + 1;
  const columns: PlacedNode[][] = Array.from({ length: count }, () => []);
  for (const node of nodes) {
    columns[column.get(node.id) ?? 0]?.push({
      ...node,
      column: column.get(node.id) ?? 0,
      value: value.get(node.id) ?? 0,
      x: 0,
      y: 0,
      height: 0,
    });
  }
  const room = box.bottom - box.top;
  const scale = Math.min(
    ...columns.map((each) => {
      const sum = each.reduce((total, node) => total + node.value, 0);
      return sum > 0
        ? (room - box.padding * Math.max(0, each.length - 1)) / sum
        : Infinity;
    })
  );
  const step =
    count > 1 ? (box.right - box.left - box.nodeWidth) / (count - 1) : 0;
  for (const [index, each] of columns.entries()) {
    for (const node of each) {
      node.x = box.left + index * step;
      node.height = Math.max(
        1,
        node.value * (Number.isFinite(scale) ? scale : 0)
      );
    }
    stack(each, box);
  }
  order(columns, kept, box, sweeps);
  const placed = columns.flat();
  return {
    nodes: placed,
    links: attach(placed, kept, Number.isFinite(scale) ? scale : 0, box),
    columns: count,
  };
};

/** A ribbon of even thickness from its source to its target: two smooth curves and the ends, as an SVG path. */
export const ribbonPath = (link: PlacedLink): string => {
  const middle = (link.x0 + link.x1) / 2;
  const { x0, x1, sy, ty, width } = link;
  return `M${x0},${sy}C${middle},${sy} ${middle},${ty} ${x1},${ty}L${x1},${ty + width}C${middle},${ty + width} ${middle},${sy + width} ${x0},${sy + width}Z`;
};

/** Every link on a path through `link`: all that flows into its source, and all that flows on from its target. */
export const pathThrough = (
  links: readonly ChartSankeyLink[],
  start: { source: string; target: string }
): Set<number> => {
  const lit = new Set<number>();
  const walk = (id: string, side: "up" | "down") => {
    for (const [index, link] of links.entries()) {
      const near = side === "up" ? link.target === id : link.source === id;
      if (near && !lit.has(index)) {
        lit.add(index);
        walk(side === "up" ? link.source : link.target, side);
      }
    }
  };
  for (const [index, link] of links.entries()) {
    if (link.source === start.source && link.target === start.target) {
      lit.add(index);
    }
  }
  walk(start.source, "up");
  walk(start.target, "down");
  return lit;
};
