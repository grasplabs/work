import { Button } from "@grasp-os/ui/components/button";
import { ChevronDownIcon, Icon, TableIcon } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { focusRing } from "@grasp-os/ui/lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { motionVars } from "@grasp-os/ui/lib/vars.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";
import type { ReactNode, SyntheticEvent } from "react";

import { CircleHelpIcon } from "../frame/sidebar-icons.ts";

// Page properties, from the reference's library (#2503's
// `grasp/page-properties`): under a page's title, one quiet button
// ("Properties · 1 open") that opens the page's facts and its open
// questions in place, and closes them again. The facts are read only
// (kind, source, team, updated); an open question waits for its answer
// with the person who can give it, and Ask. It is a native disclosure, so
// it opens with no script and reads as one to a screen reader: the button
// says what waits, aria-expanded says whether it is open. The rows grow
// from the button, at once with reduced motion; on a phone each name
// stands over its value. Damsko has no part for it: the Brain's own.

/** One of the page's facts: read only, a short name, its value and, if it helps, an icon. */
export interface PageFact {
  key: string;
  value: ReactNode;
  icon?: IconData;
}

/** A question the page cannot answer yet, and the person (a role) who can. */
export interface PageOpenQuestion {
  id: string;
  question: string;
  who: string;
  /** Asks them; Ask shows Asking, then Asked (or Not asked if it throws). Without it there is no Ask. */
  onAsk?: () => Promise<unknown>;
}

const grow = stylex.keyframes({
  from: { opacity: 0, transform: "scaleY(0.96)" },
  to: { opacity: 1, transform: "none" },
});

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    minWidth: 0,
  },
  // The quiet button: muted words, its count in ink, a chevron; no box until the pointer is on it.
  toggle: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
    maxWidth: "100%",
    marginInlineStart: `calc(-1 * ${space["1"]})`,
    paddingBlock: space["1"],
    paddingInline: space["1"],
    borderRadius: radius.sm,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: colors.accent },
    },
    color: colors.mutedForeground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    listStyleType: "none",
    cursor: "pointer",
    userSelect: "none",
    "::-webkit-details-marker": { display: "none" },
  },
  count: { color: colors.foreground },
  icon: {
    display: "inline-flex",
    flexShrink: 0,
    color: colors.mutedForeground,
  },
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    transitionProperty: "transform",
    transitionDuration: { default: "150ms", [media.reducedMotion]: "0s" },
  },
  chevronOpen: { transform: "rotate(180deg)" },
  // What opens: the facts, then the questions, grown from the button's start.
  body: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    width: "100%",
    paddingBlockStart: space["2"],
    transformOrigin: { default: "top left", ":dir(rtl)": "top right" },
    animationName: { default: grow, [media.reducedMotion]: "none" },
    animationDuration: motionVars.ui,
    animationTimingFunction: duration.ease,
  },
  rows: {
    display: "grid",
    // The names take what their words need, up to two fifths of the column; the values the rest.
    gridTemplateColumns: {
      default: "fit-content(40%) minmax(0, 1fr)",
      [media.maxSm]: "minmax(0, 1fr)",
    },
    columnGap: space["4"],
    rowGap: { default: space["1"], [media.maxSm]: 0 },
    margin: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  pair: { display: "contents" },
  name: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    minWidth: 0,
    margin: 0,
    paddingBlock: space["1"],
    color: colors.mutedForeground,
  },
  // On a phone each name stands over its value, so a long value keeps the whole width.
  value: {
    margin: 0,
    paddingBlock: space["1"],
    paddingBlockEnd: {
      default: space["1"],
      [media.maxSm]: space["2"],
    },
    paddingInlineStart: {
      default: 0,
      [media.maxSm]: `calc(1em + ${space["2"]})`,
    },
    color: colors.foreground,
    minWidth: 0,
    overflowWrap: "break-word",
  },
  // Not answered yet and who, then Ask held at the row's end, so the Asks stand in one column.
  waiting: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: space["2"],
    color: colors.mutedForeground,
  },
  waitingWords: { flexGrow: 1, minWidth: 0 },
});

/** One open question's value: not answered yet, who can answer, and Ask. */
const Waiting = ({ open }: { open: PageOpenQuestion }) => {
  const { t } = useLingui();
  const { onAsk, who, question } = open;
  const role = who.toLowerCase();
  return (
    <span {...stylex.props(styles.waiting)}>
      <span {...stylex.props(styles.waitingWords)}>
        {t`Not answered yet`} · {who}
      </span>
      {onAsk === undefined ? null : (
        <Button
          aria-label={t`Ask the ${role}: ${question}`}
          errorText={t`Not asked`}
          loadingText={t`Asking`}
          onClick={async () => {
            await onAsk();
          }}
          size="xs"
          successText={t`Asked`}
          variant="ghost"
        >
          {t({ message: "Ask", context: "ask the person who can answer" })}
        </Button>
      )}
    </span>
  );
};

/** A row's name, with its icon when it has one. */
const Name = ({
  icon,
  children,
}: {
  icon: IconData | undefined;
  children: ReactNode;
}) => (
  <dt {...stylex.props(styles.name)}>
    {icon === undefined ? null : (
      <span aria-hidden="true" {...stylex.props(styles.icon)}>
        <Icon icon={icon} />
      </span>
    )}
    <span>{children}</span>
  </dt>
);

/** No open questions. */
const none: readonly PageOpenQuestion[] = [];

export const PageProperties = ({
  facts,
  questions = none,
  defaultOpen = false,
}: {
  facts: readonly PageFact[];
  /** Waiting for an answer: each a row of its own after the facts, and their count on the button. */
  questions?: readonly PageOpenQuestion[] | undefined;
  /** Open at first. @default false */
  defaultOpen?: boolean;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const toggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    setOpen(event.currentTarget.open);
  };
  const waiting = questions.length;
  return (
    <details
      data-slot="page-properties"
      onToggle={toggle}
      open={open}
      {...stylex.props(styles.root)}
    >
      <summary
        aria-controls={bodyId}
        {...stylex.props(styles.toggle, focusRing)}
      >
        <span aria-hidden="true" {...stylex.props(styles.icon)}>
          <Icon icon={TableIcon} />
        </span>
        <span>
          {t`Properties`}
          {waiting > 0 ? (
            <span {...stylex.props(styles.count)}>
              {` · ${t`${plural(waiting, { one: "# open", other: "# open" })}`}`}
            </span>
          ) : null}
        </span>
        <span
          aria-hidden="true"
          {...stylex.props(styles.chevron, open && styles.chevronOpen)}
        >
          <Icon icon={ChevronDownIcon} />
        </span>
      </summary>
      <div id={bodyId} {...stylex.props(styles.body)}>
        <dl {...stylex.props(styles.rows)}>
          {facts.map((fact) => (
            <div key={fact.key} {...stylex.props(styles.pair)}>
              <Name icon={fact.icon}>{fact.key}</Name>
              <dd {...stylex.props(styles.value)}>{fact.value}</dd>
            </div>
          ))}
          {questions.map((question) => (
            <div key={question.id} {...stylex.props(styles.pair)}>
              <Name icon={CircleHelpIcon}>{question.question}</Name>
              <dd {...stylex.props(styles.value)}>
                <Waiting open={question} />
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
};
