import type {
  OnboardingProgress,
  Programme,
} from "@grasp-os/shared/onboarding";
import type { RunActivity, WorkflowSummary } from "@grasp-os/shared/workflows";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";

import { plainText } from "../chat/chat-markdown.ts";
import { formatDate } from "../format.ts";
import type { Loaded } from "../load-from-core.tsx";
import { signalKinds } from "./board.ts";
import { inProgramme, programmeWeek } from "./programme.ts";
import type { NextReport } from "./programme.ts";
import { signalKindLooks } from "./signals.tsx";
import type { Signals } from "./signals.tsx";

// The weekly report, as the prototype's (`lib/report.ts`) where core has
// what it says: assembled when it is exported, from what the dashboard
// read, as it stands then. What ran, the decisions runs asked for, each
// workflow, what could be better, and, for admins, how many people the
// interviews heard. No hours, euros or goals: core keeps none of them. It
// is Markdown, which the dialog shows and the export saves or prints
// (export/export-file.tsx); what people typed (workflow and engine names)
// is escaped, never read as Markdown.

/** What the report is made from: the dashboard's reads, each as it came. */
export interface ReportReads {
  runs: Loaded<RunActivity>;
  workflows: Loaded<WorkflowSummary[]>;
  signals: Loaded<Signals>;
  /** How many the interviews heard; undefined for anyone who may not read it. */
  people: Loaded<OnboardingProgress | null> | undefined;
}

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
export const programmeLine = (
  programme: Programme,
  today: string,
  i18n: I18n
): string => {
  const week = programmeWeek(programme.start, today);
  const { weeks } = programme;
  if (programme.stage === null) {
    return inProgramme(week)
      ? i18n._(msg`Week ${week} of ${weeks}`)
      : i18n._(msg`Week ${week}`);
  }
  const stage = i18n._(stageNames[programme.stage]);
  return inProgramme(week)
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
  const sumOf = (outcome: "completed" | "failed" | "waiting"): number =>
    data.days.reduce((sum, day) => sum + day[outcome], 0);
  const completed = sumOf("completed");
  const failed = sumOf("failed");
  const waiting = sumOf("waiting");
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
  overview: Loaded<WorkflowSummary[]>,
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
        msg`${name} in ${engine}: ${started} started, ${completed} completed, ${failed} failed`
      )
    );
  });
  const ranNames = new Set(
    runs.data.workflows.map(({ app, workflow }) => `${app}/${workflow}`)
  );
  const idle =
    overview.state === "ready"
      ? overview.data.filter(
          ({ app, workflow }) => !ranNames.has(`${app}/${workflow}`)
        ).length
      : 0;
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
const betterSection = (signals: Loaded<Signals>, i18n: I18n): string[] => {
  const heading = `## ${i18n._(msg`What could be better`)}`;
  if (signals.state !== "ready") {
    return [heading, unread(i18n)];
  }
  const { improvement, knowledge } = signals.data;
  if (improvement === undefined && knowledge === undefined) {
    return [];
  }
  const counts = signalKinds([
    ...(improvement?.signals ?? []),
    ...(knowledge?.signals ?? []),
  ]);
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
      item(i18n._(msg`Everyone else: ${talked} of ${asked}`)),
    ].join("\n"),
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
    ...workflowsSection(reads.runs, reads.workflows, i18n),
    ...betterSection(reads.signals, i18n),
    ...peopleSection(reads.people, i18n),
    "---",
    i18n._(msg`Made with Grasp on ${date}`),
  ].join("\n\n");
};

/** The report as its file holds it: its title, then its body. */
export const reportMarkdown = (title: string, body: string): string =>
  `# ${plainText(title)}\n\n${body}\n`;
