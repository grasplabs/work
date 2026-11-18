import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import type { ReactNode } from "react";

import {
  CardDescription,
  CardLink,
  CardMedia,
  CardTitle,
} from "../grasp/card/index.ts";
import { Link as TextLink } from "../grasp/link/index.ts";
import { PageHeader } from "../grasp/page-header/index.ts";
import { Separator } from "../grasp/separator/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { brainSections, findFolder, shownCount } from "./brain-sections.ts";
import { folderTree, groupLabel } from "./brain.ts";
import type { Brain, Group } from "./brain.ts";

// The brain's home and the pictures of its parts, as the prototype draws
// them (`components/brain-home.tsx`).

/* ── Pictures ────────────────────────────────────────────────────────────────────────────────── */

// The brain's own hues, the theme's `--graph-*` tokens (the map's canvas reads the same ones): the
// library has no names for them. A pale ground is the hue at 10%, its grid at 30%, a soft fill at
// 20 to 40%.
const hues = stylex.create({
  companyGround: { backgroundColor: grasp.soft },
  companyGrid: { stroke: grasp.line },
  companyLine: { stroke: grasp.ink },
  companySoft: { fill: grasp.soft },
  companyInk: { color: grasp.ink },
  visionGround: {
    backgroundColor:
      "color-mix(in oklab, var(--graph-vision) 10%, transparent)",
  },
  visionGrid: {
    stroke: "color-mix(in oklab, var(--graph-vision) 30%, transparent)",
  },
  visionLine: { stroke: "var(--graph-vision)" },
  visionSoft: {
    fill: "color-mix(in oklab, var(--graph-vision) 25%, transparent)",
  },
  visionInk: { color: "var(--graph-vision)" },
  teamsGround: {
    backgroundColor: "color-mix(in oklab, var(--graph-teams) 10%, transparent)",
  },
  teamsGrid: {
    stroke: "color-mix(in oklab, var(--graph-teams) 30%, transparent)",
  },
  teamsLine: { stroke: "var(--graph-teams)" },
  teamsSoft: {
    fill: "color-mix(in oklab, var(--graph-teams) 25%, transparent)",
  },
  teamsInk: { color: "var(--graph-teams)" },
  toolsGround: {
    backgroundColor: "color-mix(in oklab, var(--graph-tools) 10%, transparent)",
  },
  toolsGrid: {
    stroke: "color-mix(in oklab, var(--graph-tools) 30%, transparent)",
  },
  toolsLine: { stroke: "var(--graph-tools)" },
  toolsSoft: {
    fill: "color-mix(in oklab, var(--graph-tools) 25%, transparent)",
  },
  toolsInk: { color: "var(--graph-tools)" },
  statementsGround: {
    backgroundColor:
      "color-mix(in oklab, var(--graph-statements) 10%, transparent)",
  },
  statementsGrid: {
    stroke: "color-mix(in oklab, var(--graph-statements) 30%, transparent)",
  },
  statementsLine: { stroke: "var(--graph-statements)" },
  statementsSoft: {
    fill: "color-mix(in oklab, var(--graph-statements) 25%, transparent)",
  },
  statementsInk: { color: "var(--graph-statements)" },
  candidatesGround: {
    backgroundColor:
      "color-mix(in oklab, var(--graph-candidates) 10%, transparent)",
  },
  candidatesGrid: {
    stroke: "color-mix(in oklab, var(--graph-candidates) 30%, transparent)",
  },
  candidatesLine: { stroke: "var(--graph-candidates)" },
  candidatesSoft: {
    fill: "color-mix(in oklab, var(--graph-candidates) 20%, transparent)",
  },
  candidatesInk: { color: "var(--graph-candidates)" },
  gapsGround: {
    backgroundColor: "color-mix(in oklab, var(--graph-gaps) 10%, transparent)",
  },
  gapsGrid: {
    stroke: "color-mix(in oklab, var(--graph-gaps) 30%, transparent)",
  },
  gapsLine: { stroke: "var(--graph-gaps)" },
  gapsSoft: {
    fill: "color-mix(in oklab, var(--graph-gaps) 20%, transparent)",
  },
  gapsInk: { color: "var(--graph-gaps)" },
  sourcesLine: { stroke: grasp.muted },
  sourcesSoft: {
    fill: "color-mix(in oklab, var(--graph-sources) 40%, transparent)",
  },
  sourcesInk: { color: grasp.muted },
  card: { fill: grasp.raised },
});

/** The StyleX styles of one group's colours. */
interface Tone {
  ground: stylex.StaticStyles;
  grid: stylex.StaticStyles;
  line: stylex.StaticStyles;
  fill: stylex.StaticStyles;
  soft: stylex.StaticStyles;
  ink: stylex.StaticStyles;
}

/** Each group's colours: a pale ground, the grid on it, the drawing's lines and fills, and an icon's ink. */
export const tone: Record<Group, Tone> = {
  company: {
    ground: hues.companyGround,
    grid: hues.companyGrid,
    line: hues.companyLine,
    fill: hues.card,
    soft: hues.companySoft,
    ink: hues.companyInk,
  },
  vision: {
    ground: hues.visionGround,
    grid: hues.visionGrid,
    line: hues.visionLine,
    fill: hues.card,
    soft: hues.visionSoft,
    ink: hues.visionInk,
  },
  teams: {
    ground: hues.teamsGround,
    grid: hues.teamsGrid,
    line: hues.teamsLine,
    fill: hues.card,
    soft: hues.teamsSoft,
    ink: hues.teamsInk,
  },
  tools: {
    ground: hues.toolsGround,
    grid: hues.toolsGrid,
    line: hues.toolsLine,
    fill: hues.card,
    soft: hues.toolsSoft,
    ink: hues.toolsInk,
  },
  statements: {
    ground: hues.statementsGround,
    grid: hues.statementsGrid,
    line: hues.statementsLine,
    fill: hues.card,
    soft: hues.statementsSoft,
    ink: hues.statementsInk,
  },
  candidates: {
    ground: hues.candidatesGround,
    grid: hues.candidatesGrid,
    line: hues.candidatesLine,
    fill: hues.card,
    soft: hues.candidatesSoft,
    ink: hues.candidatesInk,
  },
  gaps: {
    ground: hues.gapsGround,
    grid: hues.gapsGrid,
    line: hues.gapsLine,
    fill: hues.card,
    soft: hues.gapsSoft,
    ink: hues.gapsInk,
  },
  sources: {
    ground: hues.companyGround,
    grid: hues.companyGrid,
    line: hues.sourcesLine,
    fill: hues.card,
    soft: hues.sourcesSoft,
    ink: hues.sourcesInk,
  },
};

const styles = stylex.create({
  // A pale field; on a block the card's media around it fades it while the block is pointed at.
  panel: {
    position: "relative",
    overflow: "hidden",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    height: `calc(2 * ${grasp.space20})`,
  },
  panelShort: { height: `calc(${grasp.space24} + ${grasp.space4})` },
  grid: { position: "absolute", inset: 0, width: "100%", height: "100%" },
  middle: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  drawing: { height: `calc(2 * ${grasp.space16})` },
  drawingSmall: { height: grasp.space24 },
  // The home: a block for each part of the brain.
  blocks: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.fromPhone]: "repeat(2, minmax(0, 1fr))",
      [media.fromRail]: "repeat(3, minmax(0, 1fr))",
    },
    columnGap: grasp.space6,
    rowGap: grasp.space8,
  },
  // A block's name, with how many it holds at the far end.
  nameRow: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: grasp.space3,
    minWidth: 0,
    marginTop: grasp.space2,
  },
  count: { flexShrink: 0, fontVariantNumeric: "tabular-nums" },
  // The home as a page.
  page: { display: "flex", flex: 1, minHeight: 0 },
  article: { flex: 1, minWidth: 0, overflowY: "auto" },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space8,
    boxSizing: "border-box",
    width: "100%",
    maxWidth: grasp.pageMeasure,
    marginInline: "auto",
    paddingInline: { default: grasp.space6, [media.fromTablet]: grasp.space12 },
  },
  header: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  footer: { display: "flex", flexDirection: "column", gap: grasp.space4 },
});

/** The grid of blocks, a block's name row, and the page's column, for a part's own page. */
export const blockStyles = {
  nameRow: styles.nameRow,
  count: styles.count,
  blocks: styles.blocks,
  column: styles.column,
} as const;

/** A pale field with a dashed grid, the drawing in the middle. A note's block uses a shorter one. */
export const Panel = ({
  group,
  short = false,
  children,
}: {
  group: Group;
  short?: boolean;
  children: ReactNode;
}) => {
  const id = useId();
  const colours = tone[group];
  return (
    <div
      {...stylex.props(
        styles.panel,
        short && styles.panelShort,
        colours.ground
      )}
    >
      <svg aria-hidden="true" {...stylex.props(styles.grid)}>
        <defs>
          <pattern height="28" id={id} patternUnits="userSpaceOnUse" width="28">
            <path
              d="M28 0H0V28"
              fill="none"
              strokeDasharray="3 3"
              strokeWidth="1"
              {...stylex.props(colours.grid)}
            />
          </pattern>
        </defs>
        <rect fill={`url(#${id})`} height="100%" width="100%" />
      </svg>
      <div {...stylex.props(styles.middle)}>{children}</div>
    </div>
  );
};

/** Lines are drawn in the group's colour, surfaces white or softly tinted, as one set of drawings. */
const stroke = {
  strokeWidth: 1.5,
  strokeLinejoin: "round",
  strokeLinecap: "round",
} as const;

/** A part of the brain's drawing, on its block on the home; `small` for the banner of a note's page. */
export const Drawing = ({
  group,
  small = false,
}: {
  group: Group;
  small?: boolean;
}) => {
  const { line, fill, soft } = tone[group];
  const surface = [line, fill] as const;
  const tinted = [line, soft] as const;
  switch (group) {
    case "vision": {
      // A flag on the top of a hill, the sun behind it: where the sprint is going.
      return (
        <svg
          aria-hidden="true"
          {...stylex.props(small ? styles.drawingSmall : styles.drawing)}
          viewBox="0 0 200 120"
          {...stroke}
        >
          <circle {...stylex.props(tinted)} cx="138" cy="38" r="14" />
          <path
            {...stylex.props(surface)}
            d="M30 104 L86 50 L112 74 L128 60 L172 104 Z"
          />
          <path {...stylex.props(tinted)} d="M86 50 L98 62 L90 66 L80 60 Z" />
          <path {...stylex.props(line)} d="M86 50 V18" fill="none" />
          <path {...stylex.props(tinted)} d="M86 18 L110 25 L86 32 Z" />
        </svg>
      );
    }
    case "teams": {
      // Three people side by side, the middle one in front.
      return (
        <svg
          aria-hidden="true"
          {...stylex.props(small ? styles.drawingSmall : styles.drawing)}
          viewBox="0 0 200 120"
          {...stroke}
        >
          <circle {...stylex.props(surface)} cx="62" cy="46" r="13" />
          <path {...stylex.props(surface)} d="M36 96 C36 74 88 74 88 96 Z" />
          <circle {...stylex.props(surface)} cx="138" cy="46" r="13" />
          <path
            {...stylex.props(surface)}
            d="M112 96 C112 74 164 74 164 96 Z"
          />
          <circle {...stylex.props(tinted)} cx="100" cy="40" r="16" />
          <path {...stylex.props(tinted)} d="M68 102 C68 74 132 74 132 102 Z" />
        </svg>
      );
    }
    case "candidates": {
      // A process as three steps, the middle one lifted out to be improved.
      return (
        <svg
          aria-hidden="true"
          {...stylex.props(small ? styles.drawingSmall : styles.drawing)}
          viewBox="0 0 200 120"
          {...stroke}
        >
          <rect
            {...stylex.props(surface)}
            height="30"
            rx="7"
            width="40"
            x="18"
            y="58"
          />
          <rect
            {...stylex.props(surface)}
            height="30"
            rx="7"
            width="40"
            x="142"
            y="58"
          />
          <path
            {...stylex.props(line)}
            d="M58 73 H76 M124 73 H142"
            fill="none"
            strokeDasharray="4 4"
          />
          <rect
            {...stylex.props(tinted)}
            height="36"
            rx="8"
            width="48"
            x="76"
            y="34"
          />
          <path
            {...stylex.props(line)}
            d="M84 78 H116 L112 74 M116 78 L112 82"
            fill="none"
          />
          <path {...stylex.props(line)} d="M92 52 L98 58 L110 46" fill="none" />
        </svg>
      );
    }
    case "tools": {
      // Two app windows, one behind the other, with small apps beside them.
      return (
        <svg
          aria-hidden="true"
          {...stylex.props(small ? styles.drawingSmall : styles.drawing)}
          viewBox="0 0 200 120"
          {...stroke}
        >
          <rect
            {...stylex.props(surface)}
            height="64"
            rx="7"
            width="92"
            x="44"
            y="22"
          />
          <rect
            {...stylex.props(tinted)}
            height="64"
            rx="7"
            width="92"
            x="64"
            y="38"
          />
          <path {...stylex.props(line)} d="M64 52 H156" fill="none" />
          <circle {...stylex.props(line)} cx="74" cy="45" fill="none" r="1.5" />
          <circle {...stylex.props(line)} cx="81" cy="45" fill="none" r="1.5" />
          <rect
            {...stylex.props(surface)}
            height="22"
            rx="5"
            width="22"
            x="76"
            y="62"
          />
          <rect
            {...stylex.props(surface)}
            height="22"
            rx="5"
            width="22"
            x="104"
            y="62"
          />
          <rect
            {...stylex.props(surface)}
            height="18"
            rx="4"
            width="18"
            x="164"
            y="30"
          />
          <rect
            {...stylex.props(surface)}
            height="18"
            rx="4"
            width="18"
            x="18"
            y="80"
          />
        </svg>
      );
    }
    case "gaps": {
      // A grid of known things with one piece still missing.
      return (
        <svg
          aria-hidden="true"
          {...stylex.props(small ? styles.drawingSmall : styles.drawing)}
          viewBox="0 0 200 120"
          {...stroke}
        >
          <rect
            {...stylex.props(surface)}
            height="28"
            rx="6"
            width="28"
            x="52"
            y="20"
          />
          <rect
            {...stylex.props(surface)}
            height="28"
            rx="6"
            width="28"
            x="86"
            y="20"
          />
          <rect
            {...stylex.props(surface)}
            height="28"
            rx="6"
            width="28"
            x="120"
            y="20"
          />
          <rect
            {...stylex.props(surface)}
            height="28"
            rx="6"
            width="28"
            x="52"
            y="54"
          />
          <rect
            {...stylex.props(line)}
            fill="none"
            height="28"
            rx="6"
            strokeDasharray="4 4"
            width="28"
            x="86"
            y="54"
          />
          <rect
            {...stylex.props(surface)}
            height="28"
            rx="6"
            width="28"
            x="120"
            y="54"
          />
          <path
            {...stylex.props(line)}
            d="M96 64 C96 59 104 59 104 64 C104 68 100 68 100 72"
            fill="none"
          />
          <circle {...stylex.props(line)} cx="100" cy="76.5" r="0.8" />
          <rect
            {...stylex.props(tinted)}
            height="14"
            rx="5"
            width="96"
            x="52"
            y="88"
          />
        </svg>
      );
    }
    case "sources": {
      // A stack of documents and a speech bubble: what was shared and what was said.
      return (
        <svg
          aria-hidden="true"
          {...stylex.props(small ? styles.drawingSmall : styles.drawing)}
          viewBox="0 0 200 120"
          {...stroke}
        >
          <rect
            {...stylex.props(surface)}
            height="74"
            rx="6"
            width="58"
            x="44"
            y="30"
          />
          <rect
            {...stylex.props(surface)}
            height="74"
            rx="6"
            width="58"
            x="54"
            y="22"
          />
          <path
            {...stylex.props(line)}
            d="M64 40 H100 M64 50 H100 M64 60 H88"
            fill="none"
          />
          <path
            {...stylex.props(tinted)}
            d="M112 44 H160 A8 8 0 0 1 168 52 V78 A8 8 0 0 1 160 86 H132 L120 96 V86 H112 A8 8 0 0 1 104 78 V52 A8 8 0 0 1 112 44 Z"
          />
          <path
            {...stylex.props(line)}
            d="M118 60 H154 M118 70 H142"
            fill="none"
          />
        </svg>
      );
    }
    // The company and the statements have no part of their own to draw.
    case "company":
    case "statements": {
      return null;
    }
    default: {
      return group satisfies never;
    }
  }
};

/* ── The home ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * The company note as the brain's home, a page to go on from: one block per part of the brain,
 * each with a picture in its group's colour and what it holds. A block opens the part's own page,
 * where its notes are blocks in turn.
 */
export const BrainHome = ({ brain }: { brain: Brain }) => {
  const { i18n } = useLingui();
  const tree = folderTree(brain.notes);
  return (
    <section {...stylex.props(styles.blocks)}>
      {brainSections.map((section) => {
        const folder = findFolder(tree, section.key);
        if (!folder) {
          return null;
        }
        return (
          <CardLink
            key={section.key}
            render={
              <Link
                params={{ sectionId: section.slug }}
                to="/brain/sections/$sectionId"
              />
            }
          >
            <CardMedia>
              <Panel group={section.group}>
                <Drawing group={section.group} />
              </Panel>
            </CardMedia>
            <div {...stylex.props(styles.nameRow)}>
              <CardTitle headingLevel={2}>
                {i18n._(groupLabel[section.group])}
              </CardTitle>
              <span {...stylex.props(styles.count)}>
                <Text element="span" size="sm" tone="muted">
                  {shownCount(folder)}
                </Text>
              </span>
            </div>
            <CardDescription>{i18n._(section.description)}</CardDescription>
          </CardLink>
        );
      })}
    </section>
  );
};

/**
 * The brain's home as a page, as the prototype shows the company note: the company's name, how the
 * brain works in a few sentences, then a block for each part of it, to go on from. Under them, the
 * way to Knowledge, where the memory, skills and uploads are: the brain's own navigation has no
 * place for it.
 */
export const HomePage = ({
  brain,
  toolbar,
}: {
  brain: Brain;
  toolbar?: ReactNode;
}) => {
  const company = brain.notes.find((note) => note.kind === "company");
  return (
    <div {...stylex.props(styles.page)}>
      <article {...stylex.props(styles.article)}>
        <div {...stylex.props(styles.column)}>
          <header {...stylex.props(styles.header)}>
            {toolbar}
            <PageHeader title={company?.title} />
            {/* In plain words: in the company’s own name a team such as Finance would read as a link. */}
            {(company?.article ?? []).map((paragraph) => (
              <Text key={paragraph} size="sm" tone="muted">
                {paragraph}
              </Text>
            ))}
          </header>
          <BrainHome brain={brain} />
          <footer {...stylex.props(styles.footer)}>
            <Separator />
            <Text size="sm" tone="muted">
              <Trans>
                The memory files, skills and uploads your agents read are in{" "}
                <TextLink render={<Link to="/knowledge" />}>Knowledge</TextLink>
                .
              </Trans>
            </Text>
          </footer>
        </div>
      </article>
    </div>
  );
};
