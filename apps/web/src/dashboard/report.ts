import type {
  BoardReport,
  BoardReportPart,
  SignalCount,
} from "@grasp-os/shared/dashboard";
import { expectedMessageOf } from "@grasp-os/shared/errors";
import type {
  NextReport,
  OnboardingProgress,
  Programme,
} from "@grasp-os/shared/onboarding";
import type { RunActivity } from "@grasp-os/shared/workflows";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg, ph, plural } from "@lingui/core/macro";

import { plainText } from "../chat/chat-markdown.ts";
import type { ExportFigure } from "../export/figure-tiles.tsx";
import { formatDate } from "../format.ts";
import type { Loaded } from "../load-from-core.tsx";
import { byKindOrder } from "./board.ts";
import { signalKindLooks } from "./signals.tsx";

// The weekly report, as the prototype's (`lib/report.ts`) where core has
// what it says: core reads it in one call (`dashboard.report()`), on the
// week its own count says, and this words it, as it stands when it is
// exported. What ran, the decisions runs asked for, each
// workflow, what could be better, and, for admins, how many people the
// interviews heard. No hours, euros or goals: core keeps none of them. It
// is Markdown, which the dialog shows and the export saves or prints
// (export/export-file.tsx); what people typed (workflow and engine names)
// is escaped, never read as Markdown.

/** What the report says, each part as core read it, or why it couldn't. */
export interface ReportReads {
  runs: Loaded<RunActivity>;
  /** How many of the person's workflows didn't run in the window. */
  idle: Loaded<number>;
  /** How many signals of each kind; null for someone who reads none. */
  better: Loaded<SignalCount[] | null>;
  /** How many the interviews heard; undefined for anyone who may not read it. */
  people: Loaded<OnboardingProgress | null> | undefined;
}

/** One part of core's report, as a page loads it. */
const loadedPart = <T>(
  report: Loaded<BoardReport>,
  part: (read: BoardReport) => BoardReportPart<T>
): Loaded<T> => {
  if (report.state !== "ready") {
    return report;
  }
  const read = part(report.data);
  // Core's own words for why: not translated.
  return read.state === "read"
    ? { state: "ready", data: read.data }
    : {
        state: "refused",
        message: expectedMessageOf(read.code) ?? read.code,
      };
};

/** The report's parts, from core's read of it. */
export const readsOf = (report: Loaded<BoardReport>): ReportReads => {
  // Core says whether the person may read it; a report that couldn't be
  // read says so in every other section.
  const people = report.state === "ready" ? report.data.people : undefined;
  return {
    runs: loadedPart(report, ({ runs }) => runs),
    idle: loadedPart(report, ({ idleWorkflows }) => idleWorkflows),
    better: loadedPart(report, ({ better }) => better),
    people: people === undefined ? undefined : loadedPart(report, () => people),
  };
};

/** Each stage of the onboarding, as the dashboard's line says it. */
export const stageNames: Record<
  NonNullable<Programme["stage"]>,
  MessageDescriptor
> = {
  preparing: msg({ message: "Getting ready", context: "programme stage" }),
  interviews: msg({ message: "Interviews", context: "programme stage" }),
  waiting: msg({ message: "Waiting for the go", context: "programme stage" }),
  open: msg({ message: "Under way", context: "programme stage" }),
};

/** The programme's line: "Week 3 of 8 · Under way", or past week 8, "Week 9". */
export const programmeLine = (programme: Programme, i18n: I18n): string => {
  const { week, weeks, inProgramme } = programme;
  if (programme.stage === null) {
    return inProgramme
      ? i18n._(msg`Week ${week} of ${weeks}`)
      : i18n._(msg`Week ${week}`);
  }
  const stage = i18n._(stageNames[programme.stage]);
  return inProgramme
    ? i18n._(msg`Week ${week} of ${weeks} · ${stage}`)
    : i18n._(msg`Week ${week} · ${stage}`);
};

/** The report's title, as the dialog and the file say it. */
export const reportTitle = (next: NextReport, i18n: I18n): string => {
  const { week } = next;
  return next.inDays === 0
    ? i18n._(msg`Your report on week ${week} is ready`)
    : i18n._(msg`The report as it stands today`);
};

/** The file's name, without its extension: "grasp-report-week-3-2026-10-11". */
export const reportFileName = (week: number, today: string): string =>
  `grasp-report-week-${week}-${today}`;

/** A list item. */
const item = (text: string): string => `- ${text}`;

/** What a section says when its read failed. */
const unread = (i18n: I18n): string =>
  i18n._(msg`This couldn't be read when the report was made.`);

/** How many of the window's runs stand at `outcome` now. */
const sumOf = (
  activity: RunActivity,
  outcome: "completed" | "failed" | "waiting"
): number => activity.days.reduce((sum, day) => sum + day[outcome], 0);

/**
 * The report's key figures, as the prototype's report opens with them in
 * tiles (`lib/report.ts`): what ran in the window and how much of it no
 * one had to touch. None when its runs couldn't be read, or none ran:
 * then "What ran" says so, and a row of noughts would only repeat it.
 */
export const reportFigures = (
  runs: Loaded<RunActivity>,
  i18n: I18n
): ExportFigure[] => {
  if (runs.state !== "ready" || runs.data.runs.total === 0) {
    return [];
  }
  const { data } = runs;
  const { total, withoutPerson } = data.runs;
  const count = new Intl.NumberFormat(i18n.locale);
  const share = new Intl.NumberFormat(i18n.locale, { style: "percent" });
  return [
    {
      key: "runs",
      value: count.format(total),
      label: i18n._(
        msg({ message: "Runs started", context: "a figure of the report" })
      ),
    },
    {
      key: "completed",
      value: count.format(sumOf(data, "completed")),
      label: i18n._(
        msg({ message: "Completed", context: "a figure of the report" })
      ),
    },
    {
      key: "failed",
      value: count.format(sumOf(data, "failed")),
      label: i18n._(
        msg({ message: "Failed", context: "a figure of the report" })
      ),
    },
    {
      key: "alone",
      value: share.format(withoutPerson / total),
      label: i18n._(
        msg({
          message: "Ran without a person",
          context: "a figure of the report",
        })
      ),
    },
  ];
};

/** What ran: the runs started in the window, and how they stand now. */
const ranSection = (runs: Loaded<RunActivity>, i18n: I18n): string[] => {
  const heading = `## ${i18n._(msg`What ran`)}`;
  if (runs.state !== "ready") {
    return [heading, unread(i18n)];
  }
  const { data } = runs;
  const from = formatDate(`${data.from}T12:00:00Z`);
  const to = formatDate(`${data.to}T12:00:00Z`);
  const window = i18n._(msg`Runs started from ${from} to ${to}.`);
  const { total, withoutPerson } = data.runs;
  if (total === 0) {
    return [heading, window, i18n._(msg`No runs yet.`)];
  }
  const completed = sumOf(data, "completed");
  const failed = sumOf(data, "failed");
  const waiting = sumOf(data, "waiting");
  const share = new Intl.NumberFormat(i18n.locale, {
    style: "percent",
  }).format(withoutPerson / total);
  return [
    heading,
    window,
    [
      item(i18n._(msg`Runs: ${total}`)),
      item(i18n._(msg`Completed: ${completed}`)),
      item(i18n._(msg`Failed: ${failed}`)),
      item(i18n._(msg`Waiting for a decision: ${waiting}`)),
      item(i18n._(msg`Ran without a person: ${share}`)),
    ].join("\n"),
  ];
};

/** The decisions those runs asked people for. */
const decisionsSection = (runs: Loaded<RunActivity>, i18n: I18n): string[] => {
  const heading = `## ${i18n._(msg`Decisions`)}`;
  if (runs.state !== "ready") {
    return [heading, unread(i18n)];
  }
  const { approved, rejected, timedOut, open } = runs.data.decisions;
  if (approved + rejected + timedOut + open === 0) {
    return [heading, i18n._(msg`No run asked anyone for a decision.`)];
  }
  return [
    heading,
    [
      item(i18n._(msg`Approved: ${approved}`)),
      item(i18n._(msg`Rejected: ${rejected}`)),
      item(i18n._(msg`Timed out: ${timedOut}`)),
      item(i18n._(msg`Open: ${open}`)),
    ].join("\n"),
  ];
};

/** Each workflow that ran in the window, and how many of the others didn't. */
const workflowsSection = (
  runs: Loaded<RunActivity>,
  idleRead: Loaded<number>,
  i18n: I18n
): string[] => {
  const heading = `## ${i18n._(msg`Workflows`)}`;
  if (runs.state !== "ready") {
    return [heading, unread(i18n)];
  }
  const ran = runs.data.workflows.map((workflow) => {
    const name = plainText(workflow.workflow);
    const engine = plainText(workflow.appName);
    const { started, completed, failed } = workflow;
    return item(
      i18n._(
        msg`${name} in ${ph({ domain: engine })}: ${started} started, ${completed} completed, ${failed} failed`
      )
    );
  });
  const idle = idleRead.state === "ready" ? idleRead.data : 0;
  const listed =
    ran.length === 0
      ? i18n._(msg`No workflow ran in this time.`)
      : ran.join("\n");
  if (idle === 0) {
    return [heading, listed];
  }
  return [
    heading,
    listed,
    i18n._(
      msg`${plural(idle, {
        one: "# more workflow didn't run in this time.",
        other: "# more workflows didn't run in this time.",
      })}`
    ),
  ];
};

/** How many signals of each kind there are; none for someone who reads none. */
const betterSection = (
  better: Loaded<SignalCount[] | null>,
  i18n: I18n
): string[] => {
  const heading = `## ${i18n._(msg`What could be better`)}`;
  if (better.state !== "ready") {
    return [heading, unread(i18n)];
  }
  if (better.data === null) {
    return [];
  }
  const counts = byKindOrder(better.data);
  if (counts.length === 0) {
    return [heading, i18n._(msg`Nothing to make better right now.`)];
  }
  return [
    heading,
    counts
      .map(({ kind, count }) => {
        const name = i18n._(signalKindLooks[kind].name);
        return item(i18n._(msg`${name}: ${count}`));
      })
      .join("\n"),
  ];
};

/** How many the interviews heard, for those who may read it. */
const peopleSection = (people: ReportReads["people"], i18n: I18n): string[] => {
  if (people === undefined) {
    return [];
  }
  const heading = `## ${i18n._(msg`People heard`)}`;
  if (people.state !== "ready") {
    return [heading, unread(i18n)];
  }
  if (people.data === null) {
    return [];
  }
  const { leadsTalked, leads, talked, asked } = people.data;
  return [
    heading,
    [
      item(i18n._(msg`Team leads: ${leadsTalked} of ${leads}`)),
      item(
        i18n._(
          msg`Everyone else, in the teams whose counts may be shown: ${talked} of ${asked}`
        )
      ),
    ].join("\n"),
    i18n._(
      msg`To keep who spoke private, a team is left out until five of its people were asked, and its count until three were heard. Neither means nobody took part.`
    ),
  ];
};

/** The report's body, without its title: what the dialog shows. */
export const reportBody = (
  reads: ReportReads,
  context: { line: string; today: string },
  i18n: I18n
): string => {
  const date = formatDate(`${context.today}T12:00:00Z`);
  return [
    context.line,
    i18n._(msg`As of ${date}.`),
    ...ranSection(reads.runs, i18n),
    ...decisionsSection(reads.runs, i18n),
    ...workflowsSection(reads.runs, reads.idle, i18n),
    ...betterSection(reads.better, i18n),
    ...peopleSection(reads.people, i18n),
    "---",
    i18n._(msg`Made with Grasp on ${date}`),
  ].join("\n\n");
};

/** The report as its file holds it: its title, then its body. */
export const reportMarkdown = (title: string, body: string): string =>
  `# ${plainText(title)}\n\n${body}\n`;
