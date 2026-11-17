import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";

import { AppLogo } from "../connections/app-logo.tsx";
import { Button } from "../grasp/button/index.ts";
import {
  HoverCard,
  HoverCardContent,
  HoverCardDescription,
  HoverCardTitle,
  HoverCardTrigger,
} from "../grasp/hover-card/index.ts";
import { Minus } from "../grasp/icons/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { groupOf, kindLabel, statementWords } from "./brain.ts";
import type { Group, Note, NoteKind } from "./brain.ts";

// Notes named on a page, and rows of them, as the prototype draws them
// (`components/brain-chips.tsx`).

/**
 * The brain's own hue for each group: the `--graph-*` colours the map draws with (brain-colors.ts,
 * the atlas). The library has no token for them, as they are the brain's alone; the page reads the
 * same variables, so a name on a page has the colour of its part on the map, light and dark.
 */
const hue = {
  vision: "var(--graph-vision)",
  teams: "var(--graph-teams)",
  tools: "var(--graph-tools)",
  statements: "var(--graph-statements)",
  candidates: "var(--graph-candidates)",
  gaps: "var(--graph-gaps)",
  sources: "var(--graph-sources)",
} as const;

/** A group's hue as a soft fill behind words, so a name shows what it is before it is read. */
const soft = (colour: string, share: string): string =>
  `color-mix(in oklch, ${colour} ${share}, transparent)`;

/** The dot of each group: filled in its hue; gaps hollow, like unresolved links in Obsidian. */
const dots = stylex.create({
  dot: {
    display: "inline-block",
    flexShrink: 0,
    boxSizing: "border-box",
    width: grasp.severityDot,
    height: grasp.severityDot,
    borderRadius: grasp.cornerCircle,
  },
  company: { backgroundColor: grasp.ink },
  vision: { backgroundColor: hue.vision },
  teams: { backgroundColor: hue.teams },
  tools: { backgroundColor: hue.tools },
  statements: { backgroundColor: hue.statements },
  candidates: { backgroundColor: hue.candidates },
  gaps: { boxShadow: `inset 0 0 0 1px ${hue.gaps}` },
  sources: { backgroundColor: hue.sources },
  // An application nobody named is hollow too.
  app: { boxShadow: `inset 0 0 0 1px ${hue.tools}` },
});

/** The same hue as a soft fill, for a kind's label and for what was marked in a transcript. */
const tints = stylex.create({
  company: { backgroundColor: grasp.soft },
  vision: { backgroundColor: soft(hue.vision, "15%") },
  teams: { backgroundColor: soft(hue.teams, "15%") },
  tools: { backgroundColor: soft(hue.tools, "15%") },
  statements: { backgroundColor: soft(hue.statements, "20%") },
  candidates: { backgroundColor: soft(hue.candidates, "15%") },
  gaps: { backgroundColor: soft(hue.gaps, "15%") },
  sources: { backgroundColor: soft(hue.sources, "30%") },
});

/** What a transcript marks with the brain's hues: the search's hits, and the strip beside its statements. */
export const brainMarks = stylex.create({
  hit: {
    borderRadius: grasp.cornerMark,
    backgroundColor: soft(hue.vision, "25%"),
  },
  // The hit being stepped to stands out.
  hitCurrent: {
    borderRadius: grasp.cornerMark,
    backgroundColor: soft(hue.vision, "40%"),
    boxShadow: `0 0 0 1px ${hue.vision}`,
  },
  stripMark: { fill: hue.statements },
  stripMarkActive: { fill: grasp.ink },
});

const dotOf = (kind: NoteKind) =>
  kind === "app" ? dots.app : dots[groupOf[kind]];

/** The soft fill of `kind`'s group, for a label or a passage marked in it. */
export const tintOf = (kind: NoteKind): (typeof tints)[Group] =>
  tints[groupOf[kind]];

/** The colour dot of a note's kind. */
export const KindDot = ({ kind }: { kind: NoteKind }) => (
  <span aria-hidden="true" {...stylex.props(dots.dot, dotOf(kind))} />
);

const styles = stylex.create({
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
  // A kind's name in its group's soft fill, its dot in front.
  kind: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    paddingBlock: grasp.space1,
    paddingInline: grasp.space2,
    borderRadius: grasp.cornerMark,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    maxWidth: "100%",
    verticalAlign: "baseline",
  },
  name: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  preview: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
  },
  kindLine: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
  },
  reason: {
    paddingTop: grasp.space2,
    borderTopWidth: grasp.hairline,
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
  },
});

/** A note's kind as a label: its dot and its name in its group's soft fill. */
export const KindTag = ({ kind }: { kind: NoteKind }) => {
  const { i18n } = useLingui();
  return (
    <span {...stylex.props(styles.kind, tintOf(kind))}>
      <KindDot kind={kind} />
      {i18n._(kindLabel[kind])}
    </span>
  );
};

/** How many items a row of links shows before the rest folds behind a count. */
const perRow = 3;

/** A row of links, the first three shown and the rest behind "+N", which opens the row in place and closes it again. */
export const Capped = ({ children }: { children: ReactNode[] }) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const hidden = children.length - perRow;
  if (hidden <= 0) {
    return <span {...stylex.props(styles.row)}>{children}</span>;
  }
  const toggle = () => {
    setOpen(!open);
  };
  return (
    <span {...stylex.props(styles.row)}>
      {open ? children : children.slice(0, perRow)}
      {open ? (
        <Button
          aria-expanded
          aria-label={t`Show fewer`}
          icon={Minus}
          onClick={toggle}
          size="xs"
        />
      ) : (
        <Button
          aria-expanded={false}
          aria-label={t`${plural(hidden, { one: "Show # more", other: "Show # more" })}`}
          onClick={toggle}
          size="xs"
        >
          {`+${hidden}`}
        </Button>
      )}
    </span>
  );
};

/** What marks a note in a chip: the logo of a tool or application, else the colour dot of its kind. */
const NoteMark = ({ note }: { note: Note }) => {
  if (note.kind === "tool" || note.kind === "app") {
    return <AppLogo name={note.title} size="xs" />;
  }
  return <KindDot kind={note.kind} />;
};

/** Whether a press on a link follows it here, in the app: not one opened in a new tab or window. */
const followsHere = (event: MouseEvent): boolean =>
  !event.defaultPrevented &&
  event.button === 0 &&
  !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);

/** A note named on a page: its colour dot and name, and a preview on hover, with why it is here when the page says. */
export const NoteChip = ({
  note,
  label,
  reason,
}: {
  note: Note;
  /** The words the page names it with; its title without them. */
  label?: string | undefined;
  reason?: string | undefined;
}) => {
  const { i18n } = useLingui();
  const router = useRouter();
  const navigate = useNavigate();
  const to = { to: "/brain/$noteId", params: { noteId: note.id } } as const;
  const { href } = router.buildLocation(to);
  return (
    <HoverCard>
      {/* The card's link is a plain one: a press on it moves within the app, as a router link does. */}
      <span
        onClick={(event) => {
          if (followsHere(event)) {
            event.preventDefault();
            void navigate(to);
          }
        }}
        role="presentation"
        {...stylex.props(styles.chip)}
      >
        <HoverCardTrigger href={href}>
          <span {...stylex.props(styles.chip)}>
            <NoteMark note={note} />
            <span {...stylex.props(styles.name)}>{label ?? note.title}</span>
          </span>
        </HoverCardTrigger>
      </span>
      <HoverCardContent align="start">
        <div {...stylex.props(styles.preview)}>
          <Text element="span" size="xs" tone="muted">
            <span {...stylex.props(styles.kindLine)}>
              <KindDot kind={note.kind} />
              {i18n._(kindLabel[note.kind])}
            </span>
          </Text>
          <HoverCardTitle>
            {note.kind === "statement"
              ? statementWords(note.id, note.title)
              : note.title}
          </HoverCardTitle>
          <HoverCardDescription>{note.summary}</HoverCardDescription>
          {/* Why the note is linked from where it is shown, where the place says. */}
          {reason === undefined ? null : (
            <div {...stylex.props(styles.reason)}>
              <Text size="xs">{reason}</Text>
            </div>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
};
