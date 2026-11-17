// The layout behind ChartSankey, written here rather than taken from a library: stages as columns
// (each node at the length of its longest path from a start), each
// node as tall as the most that passes through it, nodes ordered in their column to cut crossings
// (sweeps of the weighted middle of their neighbours), and each flow as a ribbon of even thickness
// whose two edges are smooth curves. Pure, so it is tested (scripts/chart-layout.test.ts).

export interface SankeyNode {
  /** How links name it. */
  id: string;
  /** Its name, as it is read beside it. */
  label: string;
  /** An end that is not the hoped-for one (disputed, waiting): drawn quieter. */
  quiet?: boolean;
}

export interface SankeyLink {
  from: string;
  to: string;
  value: number;
}

export interface PlacedNode extends SankeyNode {
  column: number;
  value: number;
  x: number;
  y: number;
  height: number;
}

export interface PlacedLink extends SankeyLink {
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
  nodes: readonly SankeyNode[],
  links: readonly SankeyLink[]
): Map<string, number> => {
  const depth = new Map(nodes.map((node) => [node.id, 0]));
  // One pass along every link: a node takes one more than any source before it. Repeated until
  // nothing moves, as many times as there are nodes at most, so a loop in the data cannot hang it.
  const relax = () => {
    let moved = false;
    for (const link of links) {
      const next = (depth.get(link.from) ?? 0) + 1;
      if (
        depth.has(link.to) &&
        next > (depth.get(link.to) ?? 0) &&
        next < nodes.length
      ) {
        depth.set(link.to, next);
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
  nodes: readonly SankeyNode[],
  links: readonly SankeyLink[]
): Map<string, number> =>
  new Map(
    nodes.map((node) => {
      const into = links
        .filter((link) => link.to === node.id)
        .reduce((sum, link) => sum + link.value, 0);
      const out = links
        .filter((link) => link.from === node.id)
        .reduce((sum, link) => sum + link.value, 0);
      return [node.id, Math.max(into, out)];
    })
  );

/** The weighted middle of a node's neighbours on one side, or null when it has none there. */
const middleOf = (
  id: string,
  links: readonly SankeyLink[],
  centre: Map<string, number>,
  side: "from" | "to"
): number | null => {
  const near = links.filter(
    (link) => (side === "from" ? link.to : link.from) === id
  );
  const weight = near.reduce((sum, link) => sum + link.value, 0);
  if (weight <= 0) {
    return null;
  }
  return (
    near.reduce(
      (sum, link) =>
        sum +
        (centre.get(side === "from" ? link.from : link.to) ?? 0) * link.value,
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
  links: readonly PlacedLink[] | readonly SankeyLink[],
  rank: Map<string, number>,
  column: Map<string, number>
): number => {
  let count = 0;
  for (const [index, a] of links.entries()) {
    for (const b of links.slice(index + 1)) {
      const same =
        column.get(a.from) === column.get(b.from) &&
        column.get(a.to) === column.get(b.to);
      const out = (rank.get(a.from) ?? 0) - (rank.get(b.from) ?? 0);
      const into = (rank.get(a.to) ?? 0) - (rank.get(b.to) ?? 0);
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
  links: readonly SankeyLink[],
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
          middleOf(node.id, links, centre, rightward ? "from" : "to") ??
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
  links: readonly SankeyLink[],
  scale: number,
  box: SankeyBox
): PlacedLink[] => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const placed: PlacedLink[] = links.map((link, index) => {
    const source = byId.get(link.from);
    const target = byId.get(link.to);
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
      .filter((each) => each.from === node.id)
      .toSorted((a, b) => centreOf(a.to) - centreOf(b.to))) {
      link.sy = out;
      out += link.width;
    }
    let into = node.y;
    for (const link of placed
      .filter((each) => each.to === node.id)
      .toSorted((a, b) => centreOf(a.from) - centreOf(b.from))) {
      link.ty = into;
      into += link.width;
    }
  }
  return placed;
};

/** Lays out the nodes and links in the box. */
export const layoutSankey = (
  nodes: readonly SankeyNode[],
  links: readonly SankeyLink[],
  box: SankeyBox,
  sweeps = 6
): SankeyLayout => {
  const known = new Set(nodes.map((node) => node.id));
  const kept = links.filter(
    (link) =>
      link.value > 0 &&
      known.has(link.from) &&
      known.has(link.to) &&
      link.from !== link.to
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
  links: readonly SankeyLink[],
  start: { from: string; to: string }
): Set<number> => {
  const lit = new Set<number>();
  const walk = (id: string, side: "up" | "down") => {
    for (const [index, link] of links.entries()) {
      const near = side === "up" ? link.to === id : link.from === id;
      if (near && !lit.has(index)) {
        lit.add(index);
        walk(side === "up" ? link.from : link.to, side);
      }
    }
  };
  for (const [index, link] of links.entries()) {
    if (link.from === start.from && link.to === start.to) {
      lit.add(index);
    }
  }
  walk(start.from, "up");
  walk(start.to, "down");
  return lit;
};
