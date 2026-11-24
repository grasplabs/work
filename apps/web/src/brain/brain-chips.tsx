import { BrandIcon } from "@grasp-os/ui/components/brand-icon";
import { Button } from "@grasp-os/ui/components/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardDescription,
  HoverCardTitle,
  HoverCardTrigger,
} from "@grasp-os/ui/components/hover-card";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, MinusIcon } from "@grasp-os/ui/lib/icons";
import {
  colors,
  font,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { groupOf, kindLabel, statementWords } from "./brain.ts";
import type { Group, Note, NoteKind } from "./brain.ts";
import { graph } from "./graph.stylex.ts";

// Notes named on a page, and rows of them, as the prototype draws them
// (`components/brain-chips.tsx`).

/**
 * The brain's own hue for each group (graph.stylex.ts), light and dark.
 */
const hue = {
  vision: graph.vision,
  teams: graph.teams,
  tools: graph.tools,
  statements: graph.statements,
  candidates: graph.candidates,
  gaps: graph.gaps,
  sources: graph.sources,
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
    width: size.severityDot,
    height: size.severityDot,
    borderRadius: radius.circle,
  },
  company: { backgroundColor: colors.foreground },
  vision: { backgroundColor: hue.vision },
  teams: { backgroundColor: hue.teams },
  tools: { backgroundColor: hue.tools },
  statements: { backgroundColor: hue.statements },
  candidates: { backgroundColor: hue.candidates },
  gaps: { boxShadow: `inset 0 0 0 ${size.hairline} ${hue.gaps}` },
  sources: { backgroundColor: hue.sources },
  // An application nobody named is hollow too.
  app: { boxShadow: `inset 0 0 0 ${size.hairline} ${hue.tools}` },
});

/** The same hue as a soft fill, for a kind's label. */
const tints = stylex.create({
  company: { backgroundColor: colors.muted },
  vision: { backgroundColor: soft(hue.vision, "15%") },
  teams: { backgroundColor: soft(hue.teams, "15%") },
  tools: { backgroundColor: soft(hue.tools, "15%") },
  statements: { backgroundColor: soft(hue.statements, "20%") },
  candidates: { backgroundColor: soft(hue.candidates, "15%") },
  gaps: { backgroundColor: soft(hue.gaps, "15%") },
  sources: { backgroundColor: soft(hue.sources, "30%") },
});

const dotOf = (kind: NoteKind) =>
  kind === "app" ? dots.app : dots[groupOf[kind]];

/** The soft fill of `kind`'s group, for a label or a passage marked in it. */
const tintOf = (kind: NoteKind): (typeof tints)[Group] => tints[groupOf[kind]];

/** The colour dot of a note's kind. */
const KindDot = ({ kind }: { kind: NoteKind }) => (
  <span aria-hidden="true" {...stylex.props(dots.dot, dotOf(kind))} />
);

const styles = stylex.create({
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
    minWidth: 0,
  },
  // A kind's name in its group's soft fill, its dot in front.
  kind: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["2"],
    paddingBlock: space["1"],
    paddingInline: space["2"],
    borderRadius: radius.sm,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["2"],
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
    gap: space["2"],
  },
  kindLine: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
  },
  reason: {
    paddingTop: space["2"],
    borderTopWidth: size.hairline,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
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
          variant="outline"
          aria-expanded
          aria-label={t`Show fewer`}
          onClick={toggle}
          size="icon-xs"
        >
          <Icon icon={MinusIcon} />
        </Button>
      ) : (
        <Button
          variant="outline"
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

/**
 * What marks a note in a chip: a tool's or an application's first letter on BrandIcon's smallest
 * tile (what the connections' ProviderMark draws without a logo; its own sizes start at 32px,
 * too tall for a line of text), else the colour dot of its kind.
 */
const NoteMark = ({ note }: { note: Note }) => {
  if (note.kind === "tool" || note.kind === "app") {
    return <BrandIcon decorative name={note.title} size="xs" />;
  }
  return <KindDot kind={note.kind} />;
};

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
  return (
    <HoverCard>
      {/* The router's own link: a press moves within the app, a new tab opens one. */}
      <HoverCardTrigger asChild>
        <Link params={{ noteId: note.id }} to="/brain/$noteId">
          <span {...stylex.props(styles.chip)}>
            <NoteMark note={note} />
            <span {...stylex.props(styles.name)}>{label ?? note.title}</span>
          </span>
        </Link>
      </HoverCardTrigger>
      <HoverCardContent align="start">
        <div {...stylex.props(styles.preview)}>
          <Text as="span" size="xs" color="muted">
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
