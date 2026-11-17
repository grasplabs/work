// ChartSankey: how a whole moves between stages: nodes in columns, each as tall as what passes
// through it, and flows as ribbons whose thickness is their value. Each node is named beside it with
// its value; hover or focus a flow and the whole path through it lights while the rest steps back,
// with its value and its share of where it came from, said in a line under the drawing. The ribbons draw in from left to right once,
// as it arrives (still under reduced motion). On a narrow screen (under 32rem of its own width) the
// flows turn into a list by stage, each with a bar of its share.
//
//   <ChartSankey label="Where October's invoices went" summary="…" nodes={nodes} links={links} />
//
// The layout is its own (sankey.ts): columns by longest path, nodes ordered to cut crossings.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";

import { visuallyHidden } from "../hidden/hidden";
import { grasp, media } from "../tokens/tokens.stylex";
import type { ChartLayoutStyle } from "./chart";
import { ChartPatterns, DitherBands, textureOf } from "./chart-patterns";
import type { ChartFill, ChartTexture } from "./chart-patterns";
import { saidStyles } from "./chart-said";
import { measureText } from "./measure-text";
import { layoutSankey, pathThrough, ribbonPath, valuesOf } from "./sankey";
import type {
  PlacedLink,
  PlacedNode,
  SankeyLayout,
  SankeyLink,
  SankeyNode,
} from "./sankey";
import { useWidth } from "./use-width";

export type { SankeyLink, SankeyNode } from "./sankey";

/** What a flow is called for a screen reader: its ends, its value and its share of its source. */
export interface ChartSankeyFlow {
  from: string;
  to: string;
  value: string;
  share: string;
}

/** Every prop a ChartSankey takes. */
export interface ChartSankeyProps {
  /** What it shows, as a screen reader and an agent say it ("Where October's invoices went"). */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /** One sentence that says what the flows mean ("Nine in ten were paid; 61 are disputed"). */
  summary: string;
  /** The stages' nodes: an id, the name read beside it, and `quiet` for an end not hoped for. */
  nodes: readonly SankeyNode[];
  /** The flows between them, by id, with their values. */
  links: readonly SankeyLink[];
  /**
   * How the nodes are filled: `plain` in the value colour, or a dither lit at the top.
   * @default "plain"
   */
  fill?: ChartFill;
  /**
   * How tall the drawing is, in CSS pixels.
   * @default 360
   */
  height?: number;
  /** Writes a value as people read it ("1,217", "€12.4k"). */
  format?: (value: number) => string;
  /** Writes a share as people read it ("67%"). */
  formatShare?: (share: number) => string;
  /**
   * A flow's share of where it came from, in words ("67% of Received").
   * @default (share, source) => `${share} of ${source}`
   */
  shareOf?: (share: string, source: string) => string;
  /**
   * A flow as a screen reader says it.
   * @default ({ from, to, value, share }) => `${from} to ${to}: ${value}, ${share}`
   */
  flowLabel?: (flow: ChartSankeyFlow) => string;
  /** Its width and where it sits. */
  layout?: ChartLayoutStyle;
  /** @deprecated Use `layout`. */
  style?: ChartLayoutStyle;
}

// A node's width, the room between two nodes in a column, between a node and its name, and the
// width under which it turns into a list, in CSS pixels: SVG geometry and a measure.
const NODE = 12;
const PADDING = 40;
const SPACE = 8;
const NARROW = 512;
const LINE = 16;

const draw = stylex.keyframes({
  from: { transform: "scaleX(0)" },
  to: { transform: "scaleX(1)" },
});

const styles = stylex.create({
  box: { position: "relative", minWidth: 0 },
  drawing: { display: "block", overflow: "visible" },
  // The arrival: one quiet draw from left to right, the light's one longer move; none when reduced.
  arrive: {
    transformOrigin: "0 0",
    animationName: { default: draw, [media.reduced]: "none" },
    animationDuration: grasp.durationArrive,
    animationTimingFunction: grasp.ease,
    animationFillMode: "both",
  },
  flows: {
    transitionProperty: "opacity",
    transitionDuration: { default: grasp.durationHover, [media.reduced]: "0s" },
  },
  flow: {
    outline: "none",
    stroke: { default: "transparent", ":focus-visible": grasp.ring },
    strokeWidth: 2,
    transitionProperty: "opacity",
    transitionDuration: { default: grasp.durationHover, [media.reduced]: "0s" },
  },
  back: { opacity: 0.32 },
  rest: { stopColor: grasp.chartRibbon },
  restQuiet: { stopColor: grasp.chartRibbonQuiet },
  lit: { stopColor: grasp.chartRibbonLit },
  litQuiet: { stopColor: grasp.chartQuietFill },
  forced: { fill: { default: null, [media.forced]: "GrayText" } },
  node: { fill: { default: grasp.chartPlain, [media.forced]: "CanvasText" } },
  nodeQuiet: {
    fill: { default: grasp.chartNodeQuiet, [media.forced]: "GrayText" },
  },
  dither: { display: { default: null, [media.forced]: "none" } },
  name: {
    fill: grasp.text,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
  },
  value: { fill: grasp.muted, fontVariantNumeric: "tabular-nums" },
  // A name on ribbons: the full ink for both its lines.
  onRibbon: { fill: { default: grasp.ink, [media.forced]: "CanvasText" } },
  // The names lie over the ribbons; the pointer goes through them to the flow beneath.
  names: { pointerEvents: "none" },
  readout: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: grasp.space3,
    minHeight: grasp.textXsLine,
    marginBlockStart: grasp.space3,
  },
  readFlow: { color: grasp.ink, fontWeight: grasp.weightMedium },
  readValue: { color: grasp.ink, fontVariantNumeric: "tabular-nums" },
  readShare: { color: grasp.muted, fontVariantNumeric: "tabular-nums" },
  // The list on a narrow screen.
  list: {
    display: "grid",
    rowGap: grasp.space5,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  stage: { display: "grid", rowGap: grasp.space2 },
  stageHead: {
    display: "flex",
    justifyContent: "space-between",
    gap: grasp.space3,
    color: grasp.ink,
    fontWeight: grasp.weightMedium,
  },
  rows: {
    display: "grid",
    rowGap: grasp.space2,
    margin: 0,
    paddingInlineStart: grasp.space3,
    listStyle: "none",
    borderInlineStartWidth: 1,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: grasp.line,
  },
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    columnGap: grasp.space3,
    rowGap: grasp.space1,
  },
  rowName: { color: grasp.text, overflowWrap: "normal" },
  rowValue: {
    color: grasp.ink,
    fontVariantNumeric: "tabular-nums",
    textAlign: "end",
  },
  share: { color: grasp.muted, marginInlineStart: grasp.space2 },
  track: {
    display: "block",
    gridColumn: "1 / -1",
    height: 4,
    borderRadius: 2,
    backgroundColor: grasp.chartTone5,
    overflow: "hidden",
  },
  bar: (share: number) => ({
    display: "block",
    width: `${Math.round(share * 1000) / 10}%`,
    height: "100%",
    borderRadius: 2,
  }),
  barTone: {
    backgroundColor: {
      default: grasp.chartPlain,
      [media.forced]: "CanvasText",
    },
  },
  barQuiet: {
    backgroundColor: { default: grasp.chartQuiet, [media.forced]: "GrayText" },
  },
});

const plainNumber = (value: number) => value.toLocaleString();
const plainShare = (share: number) =>
  share.toLocaleString(undefined, {
    style: "percent",
    maximumFractionDigits: 0,
  });
const englishShareOf = (share: string, source: string) =>
  `${share} of ${source}`;
const englishFlowLabel = ({ from, to, value, share }: ChartSankeyFlow) =>
  `${from} to ${to}: ${value}, ${share}`;

interface Active {
  link: number;
}

// A node: plain, or its dither lit at the top, in a column.
const Node = ({
  chart,
  node,
  texture,
}: {
  chart: string;
  node: PlacedNode;
  texture: ChartTexture | null;
}) => {
  const look = node.quiet === true ? styles.nodeQuiet : styles.node;
  if (texture === null || node.quiet === true) {
    return (
      <rect
        data-node={node.id}
        x={node.x}
        y={node.y}
        width={NODE}
        height={node.height}
        rx={1}
        {...stylex.props(look)}
      />
    );
  }
  const clip = `${chart}-node-${node.id}`;
  return (
    <g data-node={node.id}>
      <clipPath id={clip}>
        <rect x={node.x} y={node.y} width={NODE} height={node.height} rx={1} />
      </clipPath>
      <rect
        x={node.x}
        y={node.y}
        width={NODE}
        height={node.height}
        rx={1}
        {...stylex.props(look)}
      />
      <g clipPath={`url(#${clip})`} {...stylex.props(styles.dither)}>
        <DitherBands
          chart={chart}
          texture={texture}
          x={node.x}
          width={NODE}
          top={node.y}
          bottom={node.y + node.height}
        />
      </g>
    </g>
  );
};

// Each node's name and value beside it: to the left of the first column, to the right of every
// other. In the columns between, a name stands on its node's own ribbons (the gap above a node was
// tried: ribbons arriving from above ran through it), so both its lines take the full ink, which
// holds 4.5:1 on a ribbon at rest, lit or stepped back, in light and dark (the check measures it).
const Names = ({
  nodes,
  columns,
  format,
}: {
  nodes: readonly PlacedNode[];
  columns: number;
  format: (value: number) => string;
}) => (
  <g aria-hidden="true" {...stylex.props(styles.names)}>
    {nodes.map((node) => {
      const first = node.column === 0 && columns > 1;
      const between = !first && node.column < columns - 1;
      const x = first ? node.x - SPACE : node.x + NODE + SPACE;
      const middle = node.y + node.height / 2;
      return (
        <text
          key={node.id}
          data-name={node.id}
          x={x}
          y={middle - LINE / 2 + 4}
          textAnchor={first ? "end" : "start"}
          {...stylex.props(styles.name, between && styles.onRibbon)}
        >
          <tspan x={x}>{node.label}</tspan>
          <tspan
            x={x}
            dy={LINE}
            {...stylex.props(styles.value, between && styles.onRibbon)}
          >
            {format(node.value)}
          </tspan>
        </text>
      );
    })}
  </g>
);

interface FlowsProps {
  chart: string;
  links: readonly PlacedLink[];
  nodes: ReadonlyMap<string, PlacedNode>;
  lit: ReadonlySet<number> | null;
  say: (link: PlacedLink) => string;
  setActive: (active: Active | null) => void;
}

// The ribbons, each a gradient from its source's tone to its target's, focusable and named.
const Flows = ({ chart, links, nodes, lit, say, setActive }: FlowsProps) => (
  <g>
    {links.map((link) => {
      const on = lit?.has(link.index) === true;
      const tone = (id: string) => {
        const quiet = nodes.get(id)?.quiet === true;
        if (on) {
          return quiet ? styles.litQuiet : styles.lit;
        }
        return quiet ? styles.restQuiet : styles.rest;
      };
      const gradient = `${chart}-flow-${link.index}`;
      const show = () => {
        setActive({ link: link.index });
      };
      return (
        <g key={link.index}>
          <linearGradient
            id={gradient}
            gradientUnits="userSpaceOnUse"
            x1={link.x0}
            x2={link.x1}
            y1={0}
            y2={0}
          >
            <stop offset="0" {...stylex.props(tone(link.from))} />
            <stop offset="1" {...stylex.props(tone(link.to))} />
          </linearGradient>
          <path
            role="graphics-symbol"
            tabIndex={0}
            aria-label={say(link)}
            data-flow={`${link.from}-${link.to}`}
            d={ribbonPath(link)}
            fill={`url(#${gradient})`}
            onPointerEnter={show}
            onPointerLeave={() => {
              setActive(null);
            }}
            onFocus={show}
            onBlur={() => {
              setActive(null);
            }}
            {...stylex.props(
              styles.flow,
              styles.forced,
              lit !== null && !on && styles.back
            )}
          />
        </g>
      );
    })}
  </g>
);

// The flows as a list by stage, for a narrow screen: each node with where its flows go.
const FlowList = ({
  nodes,
  links,
  format,
  formatShare,
}: {
  nodes: readonly SankeyNode[];
  links: readonly SankeyLink[];
  format: (value: number) => string;
  formatShare: (share: number) => string;
}) => {
  const names = new Map(nodes.map((node) => [node.id, node]));
  const sources = nodes.filter((node) =>
    links.some((link) => link.from === node.id)
  );
  return (
    <ul {...stylex.props(styles.list)}>
      {sources.map((node) => {
        const out = links
          .filter((link) => link.from === node.id)
          .toSorted((a, b) => b.value - a.value);
        const total = out.reduce((sum, link) => sum + link.value, 0);
        return (
          <li key={node.id} {...stylex.props(styles.stage)}>
            <span {...stylex.props(styles.stageHead)}>
              <span>{node.label}</span>
              <span>{format(total)}</span>
            </span>
            <ul {...stylex.props(styles.rows)}>
              {out.map((link) => {
                const target = names.get(link.to);
                const share = total > 0 ? link.value / total : 0;
                return (
                  <li key={link.to} {...stylex.props(styles.row)}>
                    <span {...stylex.props(styles.rowName)}>
                      {target?.label ?? link.to}
                    </span>
                    <span {...stylex.props(styles.rowValue)}>
                      {format(link.value)}
                      <span {...stylex.props(styles.share)}>
                        {formatShare(share)}
                      </span>
                    </span>
                    <span aria-hidden="true" {...stylex.props(styles.track)}>
                      <span
                        {...stylex.props(
                          styles.bar(share),
                          target?.quiet === true
                            ? styles.barQuiet
                            : styles.barTone
                        )}
                      />
                    </span>
                  </li>
                );
              })}
            </ul>
          </li>
        );
      })}
    </ul>
  );
};

interface Words {
  format: (value: number) => string;
  formatShare: (share: number) => string;
  shareOf: (share: string, source: string) => string;
  flowLabel: (flow: ChartSankeyFlow) => string;
}

// What the pointer or the keys are on, said in one line under the drawing, where it covers
// nothing: the flow, its value and its share of where it came from. Its room is kept when nothing
// is lit, so nothing moves as it fills.
const Readout = ({
  link,
  nodes,
  words,
}: {
  link: PlacedLink | undefined;
  nodes: ReadonlyMap<string, PlacedNode>;
  words: Words;
}) => {
  if (link === undefined) {
    return (
      <div
        aria-hidden="true"
        data-slot="chart-sankey-readout"
        {...stylex.props(styles.readout)}
      />
    );
  }
  const source = nodes.get(link.from);
  const target = nodes.get(link.to);
  const share = words.formatShare(
    source !== undefined && source.value > 0 ? link.value / source.value : 0
  );
  return (
    <div
      aria-hidden="true"
      data-slot="chart-sankey-readout"
      {...stylex.props(styles.readout)}
    >
      <span
        {...stylex.props(styles.readFlow)}
      >{`${source?.label ?? link.from} → ${target?.label ?? link.to}`}</span>
      <span {...stylex.props(styles.readValue)}>
        {words.format(link.value)}
      </span>
      <span {...stylex.props(styles.readShare)}>
        {words.shareOf(share, source?.label ?? link.from)}
      </span>
    </div>
  );
};

interface DrawingProps {
  chart: string;
  width: number;
  height: number;
  layout: SankeyLayout | null;
  byId: ReadonlyMap<string, PlacedNode>;
  lit: ReadonlySet<number> | null;
  say: (link: PlacedLink) => string;
  setActive: (active: Active | null) => void;
  texture: ChartTexture | null;
  format: (value: number) => string;
}

// The drawing: the flows and nodes drawn in from left to right as it arrives, the names beside.
const Drawing = ({
  chart,
  width,
  height,
  layout,
  byId,
  lit,
  say,
  setActive,
  texture,
  format,
}: DrawingProps) => (
  <svg width={width} height={height} {...stylex.props(styles.drawing)}>
    <ChartPatterns id={chart} />
    <clipPath id={`${chart}-arrive`}>
      <rect
        x={0}
        y={-4}
        width={width}
        height={height + 8}
        {...stylex.props(styles.arrive)}
      />
    </clipPath>
    {layout !== null && (
      <>
        <g clipPath={`url(#${chart}-arrive)`}>
          <Flows
            chart={chart}
            links={layout.links}
            nodes={byId}
            lit={lit}
            say={say}
            setActive={setActive}
          />
          <g aria-hidden="true">
            {layout.nodes.map((node) => (
              <Node key={node.id} chart={chart} node={node} texture={texture} />
            ))}
          </g>
        </g>
        <Names nodes={layout.nodes} columns={layout.columns} format={format} />
      </>
    )}
  </svg>
);

/** How a screen reader says a flow: its ends, its value and its share of its source. */
const sayOf =
  (
    byId: ReadonlyMap<string, PlacedNode>,
    { format, formatShare, shareOf, flowLabel }: Words
  ) =>
  (link: PlacedLink) => {
    const source = byId.get(link.from);
    const share = formatShare(
      source !== undefined && source.value > 0 ? link.value / source.value : 0
    );
    return flowLabel({
      from: source?.label ?? link.from,
      to: byId.get(link.to)?.label ?? link.to,
      value: format(link.value),
      share: shareOf(share, source?.label ?? link.from),
    });
  };

/** The layout at this width, with room beside the first and last columns for their names and values. */
const drawingOf = (
  nodes: readonly SankeyNode[],
  links: readonly SankeyLink[],
  width: number,
  height: number,
  format: (value: number) => string
) => {
  const through = valuesOf(nodes, links);
  // The names and values as this engine draws them, in their own type.
  const name = stylex.props(styles.name).className;
  const value = stylex.props(styles.name, styles.value).className;
  const roomFor = (ids: readonly SankeyNode[]) => {
    const widths = [
      ...measureText(
        ids.map((node) => node.label),
        name
      ),
      ...measureText(
        ids.map((node) => format(through.get(node.id) ?? 0)),
        value
      ),
    ];
    return Math.max(0, ...widths.map((box) => box.width)) + SPACE + 2;
  };
  const starts = nodes.filter(
    (node) => !links.some((link) => link.to === node.id)
  );
  const ends = nodes.filter(
    (node) => !links.some((link) => link.from === node.id)
  );
  return layoutSankey(nodes, links, {
    left: roomFor(starts),
    right: width - roomFor(ends),
    top: 4,
    bottom: height - 4,
    nodeWidth: NODE,
    padding: PADDING,
  });
};

/** Its name and layout by their new names, else their deprecated old ones (the breaking release's step 1). */
const namedAndPlaced = (given: {
  named: string | undefined;
  label: string | undefined;
  placed: ChartLayoutStyle | undefined;
  style: ChartLayoutStyle | undefined;
}) => ({
  label: given.named ?? given.label ?? "",
  style: given.placed ?? given.style,
});

export const ChartSankey = ({
  label: labelDeprecated,
  "aria-label": named,
  summary,
  nodes,
  links,
  fill = "plain",
  height = 360,
  format = plainNumber,
  formatShare = plainShare,
  shareOf = englishShareOf,
  flowLabel = englishFlowLabel,
  style: styleDeprecated,
  layout: placed,
}: ChartSankeyProps) => {
  const { label, style } = namedAndPlaced({
    named,
    label: labelDeprecated,
    placed,
    style: styleDeprecated,
  });
  const chart = `chart-${useId().replaceAll(/[^a-zA-Z0-9-]/gu, "")}`;
  const [width, watch] = useWidth();
  const [active, setActive] = useState<Active | null>(null);
  const words: Words = { format, formatShare, shareOf, flowLabel };
  const narrow = width > 0 && width < NARROW;
  const layout =
    width > 0 && !narrow
      ? drawingOf(nodes, links, width, height, format)
      : null;
  const byId = new Map((layout?.nodes ?? []).map((node) => [node.id, node]));
  const lit =
    active === null || layout === null
      ? null
      : pathThrough(
          layout.links,
          layout.links[active.link] ?? { from: "", to: "" }
        );
  const say = sayOf(byId, words);
  const texture = textureOf(fill);
  const shown =
    active === null || layout === null ? undefined : layout.links[active.link];
  return (
    <figure
      aria-labelledby={`${chart}-label`}
      data-slot="chart-sankey"
      {...stylex.props(saidStyles.figure, style)}
    >
      <figcaption {...stylex.props(visuallyHidden)}>
        <span id={`${chart}-label`}>{label}</span> <span>{summary}</span>
      </figcaption>
      <div ref={watch} {...stylex.props(styles.box)}>
        {narrow && (
          <FlowList
            nodes={nodes}
            links={links}
            format={format}
            formatShare={formatShare}
          />
        )}
        {!narrow && (
          <Drawing
            chart={chart}
            width={width}
            height={height}
            layout={layout}
            byId={byId}
            lit={lit}
            say={say}
            setActive={setActive}
            texture={texture}
            format={format}
          />
        )}
        {!narrow && <Readout link={shown} nodes={byId} words={words} />}
      </div>
    </figure>
  );
};
