import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import type { ReactNode } from "react";

import { brainSections, findFolder, shownCount } from "./brain-sections.ts";
import { folderTree, groupLabel } from "./brain.ts";
import type { Brain, Group } from "./brain.ts";

// The brain's home and the pictures of its parts, as the prototype draws
// them (`components/brain-home.tsx`).

/* ── Pictures ────────────────────────────────────────────────────────────────────────────────── */

/** Each group's colours: a pale ground, the grid on it, the drawing's lines and fills, and an icon's ink. */
export const tone: Record<
  Group,
  {
    ground: string;
    grid: string;
    line: string;
    fill: string;
    soft: string;
    ink: string;
  }
> = {
  company: {
    ground: "bg-muted",
    grid: "stroke-border",
    line: "stroke-foreground",
    fill: "fill-card",
    soft: "fill-muted",
    ink: "text-foreground",
  },
  vision: {
    ground: "bg-graph-vision/10",
    grid: "stroke-graph-vision/30",
    line: "stroke-graph-vision",
    fill: "fill-card",
    soft: "fill-graph-vision/25",
    ink: "text-graph-vision",
  },
  teams: {
    ground: "bg-graph-teams/10",
    grid: "stroke-graph-teams/30",
    line: "stroke-graph-teams",
    fill: "fill-card",
    soft: "fill-graph-teams/25",
    ink: "text-graph-teams",
  },
  tools: {
    ground: "bg-graph-tools/10",
    grid: "stroke-graph-tools/30",
    line: "stroke-graph-tools",
    fill: "fill-card",
    soft: "fill-graph-tools/25",
    ink: "text-graph-tools",
  },
  statements: {
    ground: "bg-graph-statements/10",
    grid: "stroke-graph-statements/30",
    line: "stroke-graph-statements",
    fill: "fill-card",
    soft: "fill-graph-statements/25",
    ink: "text-graph-statements",
  },
  candidates: {
    ground: "bg-graph-candidates/10",
    grid: "stroke-graph-candidates/30",
    line: "stroke-graph-candidates",
    fill: "fill-card",
    soft: "fill-graph-candidates/20",
    ink: "text-graph-candidates",
  },
  gaps: {
    ground: "bg-graph-gaps/10",
    grid: "stroke-graph-gaps/30",
    line: "stroke-graph-gaps",
    fill: "fill-card",
    soft: "fill-graph-gaps/20",
    ink: "text-graph-gaps",
  },
  sources: {
    ground: "bg-muted",
    grid: "stroke-border",
    line: "stroke-muted-foreground",
    fill: "fill-card",
    soft: "fill-graph-sources/40",
    ink: "text-muted-foreground",
  },
};

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
      className={`relative overflow-hidden rounded-xl transition-opacity group-hover:opacity-85 ${short ? "h-28" : "h-40"} ${colours.ground}`}
    >
      <svg aria-hidden="true" className="absolute inset-0 size-full">
        <defs>
          <pattern height="28" id={id} patternUnits="userSpaceOnUse" width="28">
            <path
              className={colours.grid}
              d="M28 0H0V28"
              fill="none"
              strokeDasharray="3 3"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect fill={`url(#${id})`} height="100%" width="100%" />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        {children}
      </div>
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
  const surface = `${line} ${fill}`;
  const tinted = `${line} ${soft}`;
  const height = small ? "h-24" : "h-32";
  switch (group) {
    case "vision": {
      // A flag on the top of a hill, the sun behind it: where the sprint is going.
      return (
        <svg
          aria-hidden="true"
          className={height}
          viewBox="0 0 200 120"
          {...stroke}
        >
          <circle className={tinted} cx="138" cy="38" r="14" />
          <path
            className={surface}
            d="M30 104 L86 50 L112 74 L128 60 L172 104 Z"
          />
          <path className={tinted} d="M86 50 L98 62 L90 66 L80 60 Z" />
          <path className={line} d="M86 50 V18" fill="none" />
          <path className={tinted} d="M86 18 L110 25 L86 32 Z" />
        </svg>
      );
    }
    case "teams": {
      // Three people side by side, the middle one in front.
      return (
        <svg
          aria-hidden="true"
          className={height}
          viewBox="0 0 200 120"
          {...stroke}
        >
          <circle className={surface} cx="62" cy="46" r="13" />
          <path className={surface} d="M36 96 C36 74 88 74 88 96 Z" />
          <circle className={surface} cx="138" cy="46" r="13" />
          <path className={surface} d="M112 96 C112 74 164 74 164 96 Z" />
          <circle className={tinted} cx="100" cy="40" r="16" />
          <path className={tinted} d="M68 102 C68 74 132 74 132 102 Z" />
        </svg>
      );
    }
    case "candidates": {
      // A process as three steps, the middle one lifted out to be improved.
      return (
        <svg
          aria-hidden="true"
          className={height}
          viewBox="0 0 200 120"
          {...stroke}
        >
          <rect
            className={surface}
            height="30"
            rx="7"
            width="40"
            x="18"
            y="58"
          />
          <rect
            className={surface}
            height="30"
            rx="7"
            width="40"
            x="142"
            y="58"
          />
          <path
            className={line}
            d="M58 73 H76 M124 73 H142"
            fill="none"
            strokeDasharray="4 4"
          />
          <rect
            className={tinted}
            height="36"
            rx="8"
            width="48"
            x="76"
            y="34"
          />
          <path
            className={line}
            d="M84 78 H116 L112 74 M116 78 L112 82"
            fill="none"
          />
          <path className={line} d="M92 52 L98 58 L110 46" fill="none" />
        </svg>
      );
    }
    case "tools": {
      // Two app windows, one behind the other, with small apps beside them.
      return (
        <svg
          aria-hidden="true"
          className={height}
          viewBox="0 0 200 120"
          {...stroke}
        >
          <rect
            className={surface}
            height="64"
            rx="7"
            width="92"
            x="44"
            y="22"
          />
          <rect
            className={tinted}
            height="64"
            rx="7"
            width="92"
            x="64"
            y="38"
          />
          <path className={line} d="M64 52 H156" fill="none" />
          <circle className={line} cx="74" cy="45" fill="none" r="1.5" />
          <circle className={line} cx="81" cy="45" fill="none" r="1.5" />
          <rect
            className={surface}
            height="22"
            rx="5"
            width="22"
            x="76"
            y="62"
          />
          <rect
            className={surface}
            height="22"
            rx="5"
            width="22"
            x="104"
            y="62"
          />
          <rect
            className={surface}
            height="18"
            rx="4"
            width="18"
            x="164"
            y="30"
          />
          <rect
            className={surface}
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
          className={height}
          viewBox="0 0 200 120"
          {...stroke}
        >
          <rect
            className={surface}
            height="28"
            rx="6"
            width="28"
            x="52"
            y="20"
          />
          <rect
            className={surface}
            height="28"
            rx="6"
            width="28"
            x="86"
            y="20"
          />
          <rect
            className={surface}
            height="28"
            rx="6"
            width="28"
            x="120"
            y="20"
          />
          <rect
            className={surface}
            height="28"
            rx="6"
            width="28"
            x="52"
            y="54"
          />
          <rect
            className={line}
            fill="none"
            height="28"
            rx="6"
            strokeDasharray="4 4"
            width="28"
            x="86"
            y="54"
          />
          <rect
            className={surface}
            height="28"
            rx="6"
            width="28"
            x="120"
            y="54"
          />
          <path
            className={line}
            d="M96 64 C96 59 104 59 104 64 C104 68 100 68 100 72"
            fill="none"
          />
          <circle className={line} cx="100" cy="76.5" r="0.8" />
          <rect
            className={tinted}
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
          className={height}
          viewBox="0 0 200 120"
          {...stroke}
        >
          <rect
            className={surface}
            height="74"
            rx="6"
            width="58"
            x="44"
            y="30"
          />
          <rect
            className={surface}
            height="74"
            rx="6"
            width="58"
            x="54"
            y="22"
          />
          <path
            className={line}
            d="M64 40 H100 M64 50 H100 M64 60 H88"
            fill="none"
          />
          <path
            className={tinted}
            d="M112 44 H160 A8 8 0 0 1 168 52 V78 A8 8 0 0 1 160 86 H132 L120 96 V86 H112 A8 8 0 0 1 104 78 V52 A8 8 0 0 1 112 44 Z"
          />
          <path className={line} d="M118 60 H154 M118 70 H142" fill="none" />
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
    <section className="grid gap-x-6 gap-y-8 sm:grid-cols-2 xl:grid-cols-3">
      {brainSections.map((section) => {
        const folder = findFolder(tree, section.key);
        if (!folder) {
          return null;
        }
        return (
          <Link
            className="group flex flex-col gap-3"
            key={section.key}
            params={{ sectionId: section.slug }}
            to="/brain/sections/$sectionId"
          >
            <Panel group={section.group}>
              <Drawing group={section.group} />
            </Panel>
            <span className="flex flex-col gap-1">
              <span className="flex items-baseline justify-between gap-3 text-sm font-medium">
                <span className="group-hover:underline">
                  {i18n._(groupLabel[section.group])}
                </span>
                <span className="text-muted-foreground font-normal tabular-nums">
                  {shownCount(folder)}
                </span>
              </span>
              <span className="text-muted-foreground text-sm leading-relaxed">
                {i18n._(section.description)}
              </span>
            </span>
          </Link>
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
    <div className="flex min-h-0 flex-1">
      <article className="min-w-0 flex-1 overflow-y-auto">
        <div className="@container mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pt-8 pb-24 md:px-12">
          <header className="flex flex-col gap-2.5">
            {toolbar}
            <h1 className="text-2xl font-medium tracking-tight wrap-break-word">
              {company?.title}
            </h1>
            {/* In plain words: in the company’s own name a team such as Finance would read as a link. */}
            {(company?.article ?? []).map((paragraph) => (
              <p
                className="text-muted-foreground text-sm leading-relaxed"
                key={paragraph}
              >
                {paragraph}
              </p>
            ))}
          </header>
          <BrainHome brain={brain} />
          <footer className="text-muted-foreground border-t pt-4 text-sm">
            <Trans>
              The memory files, skills and uploads your agents read are in{" "}
              <Link className="text-foreground hover:underline" to="/knowledge">
                Knowledge
              </Link>
              .
            </Trans>
          </footer>
        </div>
      </article>
    </div>
  );
};
