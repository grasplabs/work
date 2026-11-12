import type { OrgView } from "@grasp-os/shared/admin/onboarding-admin";
import { stephenOf } from "@grasp-os/shared/admin/onboarding-admin-record";
import type { StephenStats } from "@grasp-os/shared/admin/onboarding-admin-record";
import { RATINGS } from "@grasp-os/shared/admin/org-record";
import { Badge } from "@grasp-os/ui/components/badge";
/**
 * Stephen and Claire at one organization, ported from the prototype
 * (grasplabs/prototype `components/admin/org-stephen.tsx`): two of the
 * Interviews section's tabs. How they did there, as the model counts it
 * (`stephenOf`): what the people who talked to them thought of it, and how
 * many who started also finished. And how they are set up for the company.
 *
 * Their setup is changed from here (stephen-setup.tsx), kept in the
 * company's Grasp. Not here, as the prototype has it: what a review of
 * each interview found (core runs no such review, so the model says none
 * is `reviewed`).
 */
import { Stat } from "@grasp-os/ui/components/stat";
import { cn } from "@grasp-os/ui/lib/utils";

import { BarList, Figure } from "./interview-parts.tsx";
import { noInterviewsYet } from "./interviews.tsx";
import { EmptySection, Section } from "./section.tsx";
import { SetupActions } from "./stephen-setup.tsx";
import type { SetupRead } from "./stephen-setup.tsx";

const oneDecimal = new Intl.NumberFormat("en", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
/** An average, to one place. */
const decimal = (value: number): string => oneDecimal.format(value);

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
            <Stat>{`${decimal(average)} of 5`}</Stat>
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
 * How Stephen and Claire did in this company's interviews, in short: what
 * people thought of it, and how many who started also finished. The rest
 * (who people chose, how long it takes, where they stop) is in Stephen
 * Lab, organization by organization.
 */
export const InterviewersDoing = ({ view }: { view: OrgView }) => {
  const stats = stephenOf(view);
  if (stats.started === 0) {
    return <EmptySection>{noInterviewsYet(view)}</EmptySection>;
  }
  return (
    <section className="bg-border grid gap-px overflow-hidden rounded-xl border lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Rating stats={stats} />
      <Figure
        label="Finished"
        ring={{ value: stats.held, of: stats.started }}
        sub="who started also agreed"
        value={`${stats.held} of ${stats.started}`}
      />
    </section>
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
export const InterviewersSetup = ({
  view,
  clientId,
  setupRead,
}: {
  view: OrgView;
  clientId: string;
  /** The setup as core keeps it, to change it from. */
  setupRead: SetupRead;
}) => {
  const { org, state } = view;
  const setup = state.stephen ?? org.stephen;
  const wanted = org.wanted ?? "";
  return (
    <>
      <Section
        action={<SetupActions clientId={clientId} setup={setupRead} />}
        description={
          setupRead.changed
            ? "As Grasp changed it. It holds for Stephen and Claire alike."
            : "From the first conversation with the sponsor. It holds for Stephen and Claire alike."
        }
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
      </Section>
      <Section
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
      </Section>
    </>
  );
};
