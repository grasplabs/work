import { PageHeaderTitle } from "@grasp-os/ui/components/page-header";
import { Tabs, TabsList, TabsTrigger } from "@grasp-os/ui/components/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import {
  AudioLinesIcon,
  CircleDashedIcon,
  FileTextIcon,
  RadarIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";

import { formatDay } from "../format.ts";
import { useBrainData } from "./brain-data.ts";
import { brainLog, logColumns, logTabs, tabOf } from "./brain-log.ts";
import type { LogDay, LogDot, LogEntry, LogKind, LogTab } from "./brain-log.ts";
import { useLessMotion } from "./less-motion.ts";
import { Mark } from "./region-marks.tsx";
import { SinceLastLook } from "./since-last-look.tsx";

/** What each kind of line looks like. */
const icons: Record<LogKind, LucideIcon> = {
  interview: AudioLinesIcon,
  reading: FileTextIcon,
  scanning: RadarIcon,
  question: CircleDashedIcon,
};

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
  <span
    className={
      dot === "open"
        ? "bg-status-attention aspect-square w-full max-w-1.5 flex-none rounded-full"
        : "bg-foreground aspect-square w-full max-w-1.5 flex-none rounded-full"
    }
  />
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
    <div className="flex flex-col gap-2">
      <ol
        aria-label={t`Day by day`}
        className="flex h-28 items-end gap-px border-b pb-1"
      >
        {columns.map(({ day, dots }) => {
          const label = day === today ? t`Today` : formatDay(day);
          const count = dots.length;
          // One sentence: the day, and how many things came in on it.
          const summary = t`${plural(count, { one: `${label}: # thing`, other: `${label}: # things` })}`;
          return (
            <li className="flex h-full min-w-0 flex-1" key={day}>
              {count === 0 ? (
                <span className="size-full" />
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        aria-label={summary}
                        className="hover:bg-muted focus-visible:bg-muted flex size-full flex-col-reverse items-center gap-0.5 overflow-hidden rounded-sm outline-none"
                        onClick={() => {
                          document
                            .querySelector(`#${CSS.escape(dayId(day))}`)
                            ?.scrollIntoView({
                              behavior: lessMotion ? "auto" : "smooth",
                              block: "start",
                            });
                        }}
                        type="button"
                      />
                    }
                  >
                    {dots.slice(0, mostInDay).map((dot, index) => (
                      <ColumnDot dot={dot} key={index} />
                    ))}
                  </TooltipTrigger>
                  <TooltipContent>{summary}</TooltipContent>
                </Tooltip>
              )}
            </li>
          );
        })}
      </ol>
      <div className="text-muted-foreground flex justify-between text-xs">
        <span>{formatDay(first.day)}</span>
        <span>
          <Trans>Today</Trans>
        </span>
      </div>
    </div>
  );
};

/** A line's title, as the link that opens it. A week's interviews say how many, and nothing of who. */
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
  if (entry.opens === undefined) {
    return <span className="text-sm font-medium text-pretty">{text}</span>;
  }
  return (
    <Link
      className="text-sm font-medium text-pretty outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:underline"
      params={{ noteId: entry.opens }}
      to="/brain/$noteId"
    >
      {text}
    </Link>
  );
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
    <span className="text-muted-foreground truncate text-xs">{text}</span>
  );
};

/** What stands on the right of a line: a question's mark, or a dot for each thing said. */
const Aside = ({ entry }: { entry: LogEntry }) => {
  const { t } = useLingui();
  if (entry.question) {
    return (
      <span className="mt-2 flex flex-none">
        <Mark state={entry.question.open ? "open" : "known"} />
      </span>
    );
  }
  const { said } = entry;
  if (said === 0) {
    return null;
  }
  return (
    <span
      className="mt-2.5 flex flex-none justify-end gap-0.5"
      title={t`What the brain kept of it`}
    >
      <span className="sr-only">
        {t`${plural(said, { one: "# thing said", other: "# things said" })}`}
      </span>
      {Array.from({ length: Math.min(said, mostSaid) }, (_, index) => (
        <span
          aria-hidden="true"
          className="bg-foreground/50 size-1 rounded-full"
          key={index}
        />
      ))}
    </span>
  );
};

/** One line: what kind of work it was, what it was, who and how, and what it gave the brain. The whole line opens what it is about. */
const Line = ({ entry }: { entry: LogEntry }) => {
  const Icon = icons[entry.kind];
  return (
    <li className="flex flex-col">
      <div className="group hover:bg-muted/60 relative flex items-start gap-3 rounded-lg py-2 pr-2 pl-9">
        <span
          aria-hidden="true"
          className="bg-muted group-hover:bg-background flex size-7 flex-none items-center justify-center rounded-md"
        >
          <Icon className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Title entry={entry} />
          <By entry={entry} />
        </span>
        <Aside entry={entry} />
      </div>
    </li>
  );
};

/** The days on a spine of dots, each with its date where the spine runs through it; today's says so. */
const Days = ({ days, today }: { days: LogDay[]; today: string }) => {
  const { t } = useLingui();
  return (
    <ol className="relative flex flex-col">
      <span
        aria-hidden="true"
        className="dots-down dots-down-wide text-muted-foreground/40 absolute top-2 bottom-0 left-2.5 w-1"
      />
      {days.map(({ day, entries }) => (
        <li
          className="relative flex scroll-mt-4 flex-col pb-4"
          id={dayId(day)}
          key={day}
        >
          <h2 className="flex items-center gap-3 py-1 text-sm font-medium">
            <span
              aria-hidden="true"
              className="flex size-6 flex-none items-center justify-center"
            >
              <span className="bg-foreground ring-background size-2 rounded-full ring-4" />
            </span>
            {day === today ? t`Today` : formatDay(day)}
          </h2>
          <ul className="flex flex-col">
            {entries.map((entry) => (
              <Line entry={entry} key={entry.id} />
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
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="pb-chat mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-8 sm:px-6 md:px-12">
        <PageHeaderTitle>
          <Trans context="the brain's log">Activity</Trans>
        </PageHeaderTitle>
        <SinceLastLook />
        <Tabs
          onValueChange={(value: LogTab) => {
            setTab(value);
          }}
          value={tab}
        >
          <TabsList aria-label={t`Show in the log`} variant="line">
            {logTabs.map((each) => (
              <TabsTrigger className="flex-none" key={each} value={each}>
                {names[each]}
                <span className="text-muted-foreground tabular-nums">
                  {counts.get(each) ?? 0}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <DayColumns days={days} today={today} />
        {days.length === 0 ? (
          <p className="bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center">
            <Trans>Nothing of this kind yet.</Trans>
          </p>
        ) : (
          <Days days={days} today={today} />
        )}
      </div>
    </div>
  );
};
