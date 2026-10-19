/**
 * Stephen and Claire at one organization, ported from the prototype
 * (grasplabs/prototype `components/admin/org-stephen.tsx`): two of the
 * Interviews section's tabs. How they did there, every figure as the
 * model counts it (`stephenOf`): what the people who talked to them
 * thought of it, how many who started also finished, how long it takes,
 * how much of what they wrote down people left in, and where people stop.
 * And how they are set up for the company.
 *
 * Not here, as the prototype has it: what a review of each interview
 * found (core runs no such review, so the model says none is `reviewed`),
 * and changing the setup, which only core could keep.
 */
import { PHASES } from "@grasp-os/shared/admin/interviews";
import type { Phase } from "@grasp-os/shared/admin/interviews";
import type { OrgView } from "@grasp-os/shared/admin/onboarding-admin";
import { stephenOf } from "@grasp-os/shared/admin/onboarding-admin-record";
import type { StephenStats } from "@grasp-os/shared/admin/onboarding-admin-record";
import { RATINGS } from "@grasp-os/shared/admin/org-record";
import { Badge } from "@grasp-os/ui/components/badge";
import { Progress } from "@grasp-os/ui/components/progress";
import { cn } from "@grasp-os/ui/lib/utils";

import { BarList, Empty, Figure, Panel } from "./interview-parts.tsx";
import { noInterviewsYet } from "./interviews.tsx";
import { interviewerNames, interviewPhaseWords } from "./words.ts";

/**
 * The parts of an interview someone can stop in: the hello has no question
 * yet, and the read-back still waits for them to agree, so it is one.
 */
const stopPhases: Phase[] = PHASES.filter((phase) => phase !== "open");

const oneDecimal = new Intl.NumberFormat("en", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
/** An average, to one place. */
const decimal = (value: number): string => oneDecimal.format(value);

const percent = new Intl.NumberFormat("en", {
  style: "percent",
  maximumFractionDigits: 0,
});

/** What the people who talked to them thought of it: the average as a number and five dots, and how many gave each. */
const Rating = ({ stats }: { stats: StephenStats }) => {
  const { count, average, by } = stats.rating;
  const full = Math.round(average);
  return (
    <div className="bg-card flex flex-col gap-4 px-5 py-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="font-medium">What people thought of it</h2>
        <p className="text-muted-foreground">
          {count === 0
            ? "Nobody has said yet. At the end of their interview, people can say how it was: from 1 to 5."
            : `${count} of ${stats.held} said how it was, at the end of their interview.`}
        </p>
      </div>
      {count > 0 ? (
        <div className="grid items-center gap-x-8 gap-y-4 sm:grid-cols-[auto_minmax(0,1fr)]">
          <div className="flex flex-col gap-1.5">
            <span className="text-2xl leading-tight font-medium tabular-nums">
              {`${decimal(average)} of 5`}
            </span>
            <span aria-hidden className="flex gap-1">
              {RATINGS.map((rating) => (
                <span
                  className={cn(
                    "size-2.5 rounded-full",
                    rating <= full ? "bg-foreground" : "bg-border"
                  )}
                  key={rating}
                />
              ))}
            </span>
          </div>
          <BarList
            label="How many gave each"
            rows={RATINGS.toReversed().map((rating) => {
              let label = String(rating);
              if (rating === 5) {
                label = "5, very good";
              } else if (rating === 1) {
                label = "1, not good";
              }
              return { id: label, label, value: by[rating] ?? 0 };
            })}
          />
        </div>
      ) : null}
    </div>
  );
};

/**
 * Who people chose to talk with, Stephen or Claire: how many chose each,
 * as bars on one scale, and what the ones who said so thought of it.
 */
const Chose = ({ stats }: { stats: StephenStats }) => {
  const most = Math.max(1, ...stats.chose.map((each) => each.count));
  return (
    <Panel
      description="Everyone chooses at the start of their interview. The questions are the same, whoever asks them."
      title="Who people chose"
    >
      <ul
        aria-label="Who people chose"
        className="grid grid-cols-[minmax(0,max-content)_minmax(4rem,1fr)_auto_auto] items-center gap-x-4 gap-y-3 border-t px-5 py-4"
      >
        {stats.chose.map((each) => {
          const name = interviewerNames[each.interviewer];
          return (
            <li
              className="col-span-4 grid grid-cols-subgrid items-center"
              key={each.interviewer}
            >
              <span>{name}</span>
              <Progress aria-label={name} max={most} value={each.count} />
              <span className="text-right tabular-nums">{each.count}</span>
              <span className="text-muted-foreground text-right tabular-nums">
                {each.rated === 0 ? "–" : `${decimal(each.average)} of 5`}
              </span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
};

/** What the minutes of an interview come with: a lead's, or all of them. */
const minutesSub = (stats: StephenStats): string | undefined => {
  const lead = Math.round(stats.length.lead);
  const employee = Math.round(stats.length.employee);
  if (lead > 0 && employee > 0) {
    return `${lead} for a team lead`;
  }
  return Math.round(stats.minutes) === 0
    ? undefined
    : `${Math.round(stats.minutes)} minutes in all`;
};

/** How many agreed interviews took how long, by minutes, in the model's steps. */
const lengthRows = (stats: StephenStats) =>
  stats.lengths.map((each, index) => {
    const from = index === 0 ? 0 : (stats.lengths[index - 1]?.upTo ?? 0);
    let label = `${from + 1}–${each.upTo} minutes`;
    if (each.upTo === null) {
      label = `Over ${from} minutes`;
    } else if (index === 0) {
      label = `Up to ${each.upTo} minutes`;
    }
    return { id: label, label, value: each.count };
  });

/** How Stephen and Claire did in this company's interviews: a tab of the interviews. */
export const InterviewersDoing = ({ view }: { view: OrgView }) => {
  const stats = stephenOf(view);
  if (stats.started === 0) {
    return <Empty>{noInterviewsYet(view)}</Empty>;
  }
  const lead = Math.round(stats.length.lead);
  const employee = Math.round(stats.length.employee);
  const { stopped } = stats;
  let stops = "Nobody stopped halfway.";
  if (stopped === 1) {
    stops = "1 interview stopped halfway and was not picked up again.";
  } else if (stopped > 1) {
    stops = `${stopped} interviews stopped halfway and were not picked up again.`;
  }
  return (
    <>
      <section className="bg-border grid gap-px overflow-hidden rounded-xl border lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Rating stats={stats} />
        <div className="bg-border grid grid-cols-2 gap-px">
          <Figure
            label="Finished"
            ring={{ value: stats.held, of: stats.started }}
            sub="who started also agreed"
            value={`${stats.held} of ${stats.started}`}
          />
          <Figure
            label="Minutes an interview"
            sub={minutesSub(stats)}
            value={employee > 0 ? employee : lead}
          />
          <Figure
            label="Left in"
            ring={
              stats.interviews > 0
                ? { value: stats.approved, of: 1 }
                : undefined
            }
            sub="of what they wrote down"
            value={stats.interviews > 0 ? percent.format(stats.approved) : "–"}
          />
          <Figure
            label="By voice"
            ring={stats.held > 0 ? { value: stats.byVoice, of: 1 } : undefined}
            sub="the rest typed"
            value={stats.held > 0 ? percent.format(stats.byVoice) : "–"}
          />
        </div>
      </section>

      <Chose stats={stats} />

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Panel description={stops} title="Where people stop">
          {stopped > 0 ? (
            <div className="border-t px-5 py-4">
              <BarList
                label="Where people stop"
                rows={stopPhases.map((phase) => ({
                  id: phase,
                  label: interviewPhaseWords[phase],
                  value: stats.stops[phase],
                }))}
              />
            </div>
          ) : null}
        </Panel>
        <Panel
          description="The interviews people agreed to, by how many minutes they took."
          title="How long they take"
        >
          <div className="border-t px-5 py-4">
            <BarList label="How long they take" rows={lengthRows(stats)} />
          </div>
        </Panel>
      </div>
    </>
  );
};

const languageNames = new Intl.DisplayNames("en", { type: "language" });

/** A language by its name, from its locale: as it is where it has none. */
const languageOf = (locale: string): string => {
  try {
    return languageNames.of(locale) ?? locale;
  } catch {
    return locale;
  }
};

/** One part of the setup: what it is, and what it holds or that it holds nothing yet. */
const SetupPart = ({
  label,
  description,
  items,
  none,
  short = false,
}: {
  label: string;
  description: string;
  items: readonly string[];
  none: string;
  short?: boolean;
}) => (
  <div className="flex flex-col gap-3 border-t px-5 py-4">
    <div className="flex flex-col gap-0.5">
      <span>{label}</span>
      <p className="text-muted-foreground">{description}</p>
    </div>
    {items.length === 0 ? (
      <p className="text-muted-foreground">{none}</p>
    ) : (
      <ul
        className={short ? "flex flex-wrap gap-1.5" : "flex flex-col gap-1.5"}
      >
        {items.map((item) => (
          <li key={item}>
            {short ? <Badge variant="outline">{item}</Badge> : item}
          </li>
        ))}
      </ul>
    )}
  </div>
);

/** How the interviewers are set up for this company: a tab of the interviews. */
export const InterviewersSetup = ({ view }: { view: OrgView }) => {
  const { org, state } = view;
  const setup = state.stephen ?? org.stephen;
  const wanted = org.wanted ?? "";
  return (
    <>
      <Panel
        description="From the first conversation with the sponsor. It holds for Stephen and Claire alike."
        title="How Stephen and Claire are set up here"
      >
        <SetupPart
          description="Someone chooses their own language when they open their link."
          items={setup.languages.map(languageOf)}
          label="Languages they interview in"
          none="None named yet: the company’s own Grasp doesn’t say which."
          short
        />
        {wanted === "" ? null : (
          <p className="text-status-attention border-t px-5 py-4">
            People there also need {wanted}, which Stephen and Claire don’t
            speak yet.
          </p>
        )}
        <SetupPart
          description="They don’t ask about it, and move on when somebody brings it up."
          items={setup.limits}
          label="What they leave alone"
          none="Nothing yet."
        />
        <SetupPart
          description="Tools, products and the company’s own words, so they hear them right."
          items={setup.terms}
          label="Words they have to know"
          none="None yet."
          short
        />
      </Panel>
      <Panel
        description="A line each, from the first conversation, the research and what the company connected."
        title="What they know before they say hello"
      >
        {org.brief.length === 0 ? (
          <p className="text-muted-foreground border-t px-5 py-4">
            Nothing yet.
          </p>
        ) : (
          <ul className="flex flex-col">
            {org.brief.map((line) => (
              <li className="border-t px-5 py-2.5" key={line}>
                {line}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
};
