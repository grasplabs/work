import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { formatDay } from "../format.ts";
import { EmptyCard } from "../frame/page.tsx";
import { Heading } from "../grasp/heading/index.ts";
import { File, Listening, Question, Search } from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { PageHeader } from "../grasp/page-header/index.ts";
import { Tabs, TabsList, TabsTrigger } from "../grasp/tabs/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { useBrainData } from "./brain-data.ts";
import { brainLog, logColumns, logTabs, tabOf } from "./brain-log.ts";
import type { LogDay, LogDot, LogEntry, LogKind, LogTab } from "./brain-log.ts";
import { useLessMotion } from "./less-motion.ts";
import { Mark } from "./region-marks.tsx";
import { SinceLastLook } from "./since-last-look.tsx";

/** What each kind of line looks like. */
const icons: Record<LogKind, IconData> = {
  interview: Listening,
  reading: File,
  scanning: Search,
  question: Question,
};

/** Room before a line, so it stands right of the spine: the day's dot (24px) and the gap after it. */
const besideSpine = `calc(${grasp.space6} + ${grasp.space3})`;

const styles = stylex.create({
  // The brain's own pane that scrolls, its column in the middle.
  pane: { flexGrow: 1, minHeight: 0, overflowY: "auto" },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space6,
    boxSizing: "border-box",
    width: "100%",
    maxWidth: grasp.pageColumnMeasure,
    marginInline: "auto",
    paddingInline: {
      default: grasp.space4,
      [media.fromPhone]: grasp.space6,
      [media.fromTablet]: grasp.space12,
    },
  },
  chart: { display: "flex", flexDirection: "column", gap: grasp.space2 },
  // The days as columns of dots, standing on a hairline.
  columns: {
    display: "flex",
    alignItems: "flex-end",
    gap: grasp.hairline,
    height: `calc(${grasp.space24} + ${grasp.space4})`,
    margin: 0,
    padding: 0,
    paddingBlockEnd: grasp.space1,
    listStyle: "none",
    borderBlockEndWidth: grasp.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: grasp.line,
  },
  day: {
    display: "flex",
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    height: "100%",
  },
  fill: { width: "100%", height: "100%" },
  dayButton: {
    display: "flex",
    flexDirection: "column-reverse",
    alignItems: "center",
    gap: grasp.space1,
    width: "100%",
    height: "100%",
    padding: 0,
    overflow: "hidden",
    borderWidth: 0,
    borderRadius: grasp.cornerMark,
    outline: "none",
    cursor: "pointer",
    backgroundColor: {
      default: "transparent",
      ":hover": grasp.ghostFillHover,
      ":focus-visible": grasp.ghostFillHover,
    },
  },
  dot: {
    flexShrink: 0,
    width: "100%",
    maxWidth: grasp.severityDot,
    aspectRatio: "1",
    borderRadius: grasp.cornerCircle,
    backgroundColor: grasp.ink,
  },
  dotOpen: { backgroundColor: grasp.attention },
  ends: { display: "flex", justifyContent: "space-between" },
  // The days on a spine of dots.
  days: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  spine: {
    position: "absolute",
    insetBlockStart: grasp.space2,
    insetBlockEnd: 0,
    insetInlineStart: `calc(${grasp.space3} - ${grasp.hairline})`,
    borderInlineStartWidth: grasp.ringWidth,
    borderInlineStartStyle: "dotted",
    borderInlineStartColor: grasp.line,
  },
  dayPart: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    paddingBlockEnd: grasp.space4,
    scrollMarginTop: grasp.space4,
  },
  dayHead: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    paddingBlock: grasp.space1,
  },
  dayDotBox: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    width: grasp.space6,
    height: grasp.space6,
  },
  // The day's own dot, ringed in the page's paper so the spine stops at it.
  dayDot: {
    width: grasp.space2,
    height: grasp.space2,
    borderRadius: grasp.cornerCircle,
    backgroundColor: grasp.ink,
    boxShadow: `0 0 0 ${grasp.space1} ${grasp.shellCard}`,
  },
  lines: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  line: { marginInlineStart: besideSpine },
  said: { display: "flex", justifyContent: "flex-end", gap: grasp.space1 },
  saidDot: {
    width: grasp.space1,
    height: grasp.space1,
    borderRadius: grasp.cornerCircle,
    backgroundColor: grasp.quiet,
  },
  aside: { display: "flex", flexShrink: 0 },
  unseen: {
    position: "absolute",
    width: grasp.hairline,
    height: grasp.hairline,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
});

/** The tab a value of the tabs names, if it names one. */
const tabFrom = (value: string | null): LogTab | undefined =>
  logTabs.find((each) => each === value);

/** The most dots a day's column and a line's row draw; past them, more is not more legible. */
const mostInDay = 14;
const mostSaid = 12;

/** The id a day's part of the log has, for its column to bring it into view. */
const dayId = (day: string): string => `log-${day}`;

/** Today, as an ISO date where the reader is. */
const todayHere = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
};

const ColumnDot = ({ dot }: { dot: LogDot }) => (
  <span {...stylex.props(styles.dot, dot === "open" && styles.dotOpen)} />
);

/**
 * Every day from the first to today as a column of dots, one for everything that came in or
 * happened that day: filled when it was taken in, in the attention colour for a question still
 * open. A day with something in it brings its part of the log into view.
 */
const DayColumns = ({ days, today }: { days: LogDay[]; today: string }) => {
  const { t } = useLingui();
  // With less motion the log jumps to the day instead of gliding there.
  const lessMotion = useLessMotion();
  const columns = logColumns(days, today);
  const [first] = columns;
  if (first === undefined) {
    return null;
  }
  return (
    <div {...stylex.props(styles.chart)}>
      <ol aria-label={t`Day by day`} {...stylex.props(styles.columns)}>
        {columns.map(({ day, dots }) => {
          const label = day === today ? t`Today` : formatDay(day);
          const count = dots.length;
          // One sentence: the day, and how many things came in on it.
          const summary = t`${plural(count, { one: `${label}: # thing`, other: `${label}: # things` })}`;
          return (
            <li key={day} {...stylex.props(styles.day)}>
              {count === 0 ? (
                <span {...stylex.props(styles.fill)} />
              ) : (
                // The day's own words show as the pointer rests on it, and
                // are its name: a column of dots holds no words.
                <button
                  aria-label={summary}
                  onClick={() => {
                    document
                      .querySelector(`#${CSS.escape(dayId(day))}`)
                      ?.scrollIntoView({
                        behavior: lessMotion ? "auto" : "smooth",
                        block: "start",
                      });
                  }}
                  title={summary}
                  type="button"
                  {...stylex.props(styles.dayButton)}
                >
                  {dots.slice(0, mostInDay).map((dot, index) => (
                    <ColumnDot dot={dot} key={index} />
                  ))}
                </button>
              )}
            </li>
          );
        })}
      </ol>
      <div {...stylex.props(styles.ends)}>
        <Text element="span" size="xs" tone="muted">
          {formatDay(first.day)}
        </Text>
        <Text element="span" size="xs" tone="muted">
          <Trans>Today</Trans>
        </Text>
      </div>
    </div>
  );
};

/** A line's title. A week's interviews say how many, and nothing of who. */
const Title = ({ entry }: { entry: LogEntry }) => {
  const { t } = useLingui();
  const week = entry.interviews?.week ?? 0;
  const count = entry.interviews?.count ?? 0;
  let { title } = entry;
  if (entry.interviews) {
    title = plural(count, {
      one: `# interview in week ${week}`,
      other: `# interviews in week ${week}`,
    });
  }
  let text = title;
  if (entry.question?.step === "answered") {
    text = t`Answered: ${title}`;
  } else if (entry.question?.step === "asked") {
    text = t`Asked: ${title}`;
  }
  return <ItemTitle>{text}</ItemTitle>;
};

/** Who gave it, and how; for a week's interviews, where what was said is. */
const By = ({ entry }: { entry: LogEntry }) => {
  const { t } = useLingui();
  const who = entry.by ?? "";
  const answer = entry.question?.answer;
  let text = entry.by;
  if (entry.interviews) {
    text = t`What was said is on the work it was about`;
  } else if (entry.question?.step === "noticed") {
    text = t`Grasp noticed it did not know`;
  } else if (entry.question?.step === "asked") {
    text = t`Sent to the ${who}`;
  } else if (answer !== undefined) {
    text = t`${who}: “${answer}”`;
  }
  return text === undefined || text === "" ? null : (
    <ItemDescription>{text}</ItemDescription>
  );
};

/** What stands on the right of a line: a question's mark, or a dot for each thing said. */
const Aside = ({ entry }: { entry: LogEntry }) => {
  const { t } = useLingui();
  if (entry.question) {
    return (
      <ItemActions>
        <span {...stylex.props(styles.aside)}>
          <Mark state={entry.question.open ? "open" : "known"} />
        </span>
      </ItemActions>
    );
  }
  const { said } = entry;
  if (said === 0) {
    return null;
  }
  return (
    <ItemActions>
      <span title={t`What the brain kept of it`} {...stylex.props(styles.said)}>
        <span {...stylex.props(styles.unseen)}>
          {t`${plural(said, { one: "# thing said", other: "# things said" })}`}
        </span>
        {Array.from({ length: Math.min(said, mostSaid) }, (_, index) => (
          <span
            aria-hidden="true"
            key={index}
            {...stylex.props(styles.saidDot)}
          />
        ))}
      </span>
    </ItemActions>
  );
};

/** One line: what kind of work it was, what it was, who and how, and what it gave the brain. The whole line opens what it is about. */
const Line = ({ entry }: { entry: LogEntry }) => {
  const parts = (
    <>
      <ItemMedia icon={icons[entry.kind]} />
      <ItemContent>
        <Title entry={entry} />
        <By entry={entry} />
      </ItemContent>
      <Aside entry={entry} />
    </>
  );
  if (entry.opens === undefined) {
    return (
      <Item layout={styles.line} size="sm">
        {parts}
      </Item>
    );
  }
  return (
    <Item
      layout={styles.line}
      render={<Link params={{ noteId: entry.opens }} to="/brain/$noteId" />}
      size="sm"
    >
      {parts}
    </Item>
  );
};

/** The days on a spine of dots, each with its date where the spine runs through it; today's says so. */
const Days = ({ days, today }: { days: LogDay[]; today: string }) => {
  const { t } = useLingui();
  return (
    <ol {...stylex.props(styles.days)}>
      <span aria-hidden="true" {...stylex.props(styles.spine)} />
      {days.map(({ day, entries }) => (
        <li id={dayId(day)} key={day} {...stylex.props(styles.dayPart)}>
          <Heading level={2} size="ui-sm">
            <span {...stylex.props(styles.dayHead)}>
              <span aria-hidden="true" {...stylex.props(styles.dayDotBox)}>
                <span {...stylex.props(styles.dayDot)} />
              </span>
              {day === today ? t`Today` : formatDay(day)}
            </span>
          </Heading>
          <ul {...stylex.props(styles.lines)}>
            {entries.map((entry) => (
              <li key={entry.id}>
                <Line entry={entry} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
};

/**
 * The brain's log, as the Runs of the workflows are theirs (the prototype's
 * `components/knowledge/brain-log.tsx`): one row of tabs for the kind of
 * work, the days as columns of dots, one for everything the brain took in,
 * then the days themselves on a spine, newest first. Every line opens what
 * it is about.
 */
export const BrainLog = () => {
  const { t } = useLingui();
  const { workspace, brain } = useBrainData();
  const [tab, setTab] = useState<LogTab>("all");
  const all = brainLog(workspace, brain);
  const days = tab === "all" ? all : brainLog(workspace, brain, tab);
  const counts = new Map<LogTab, number>([["all", 0]]);
  for (const entry of all.flatMap((day) => day.entries)) {
    const kind = tabOf(entry);
    const many = entry.interviews?.count ?? 1;
    counts.set(kind, (counts.get(kind) ?? 0) + many);
    counts.set("all", (counts.get("all") ?? 0) + many);
  }
  const today = todayHere();
  const names: Record<LogTab, string> = {
    all: t`All`,
    interview: t`Interviews`,
    reading: t`Documents`,
    scanning: t`Connections`,
    grasp: t({
      message: "Grasp",
      comment: "tab: what Grasp did itself, its questions",
    }),
  };
  return (
    <div {...stylex.props(styles.pane)}>
      <div {...stylex.props(styles.column)}>
        <PageHeader title={<Trans context="the brain's log">Activity</Trans>} />
        <SinceLastLook />
        <Tabs
          onValueChange={(value) => {
            const next = tabFrom(value);
            if (next !== undefined) {
              setTab(next);
            }
          }}
          value={tab}
          variant="line"
        >
          <TabsList aria-label={t`Show in the log`}>
            {logTabs.map((each) => (
              <TabsTrigger key={each} value={each}>
                {names[each]}{" "}
                <Text element="span" size="sm" tone="quiet">
                  {counts.get(each) ?? 0}
                </Text>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <DayColumns days={days} today={today} />
        {days.length === 0 ? (
          <EmptyCard>
            <Trans>Nothing of this kind yet.</Trans>
          </EmptyCard>
        ) : (
          <Days days={days} today={today} />
        )}
      </div>
    </div>
  );
};
