import type { OrgView } from "@grasp-os/shared/admin/onboarding-admin";
import { stephenOf } from "@grasp-os/shared/admin/onboarding-admin-record";
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

import { BarList } from "./interview-parts.tsx";
import { noInterviewsYet } from "./interviews.tsx";
import { Attention, Figure } from "./parts.tsx";
import { EmptySection, Section } from "./section.tsx";
import { SetupActions } from "./stephen-setup.tsx";
import type { SetupRead } from "./stephen-setup.tsx";

const oneDecimal = new Intl.NumberFormat("en", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
/** An average, to one place. */
const decimal = (value: number): string => oneDecimal.format(value);

/**
 * How Stephen and Claire did in this company's interviews, in short: what
 * people thought of it and how many who started also finished, as two
 * figures, then how many gave each rating. The rest (who people chose, how
 * long it takes, where they stop) is in Stephen Lab, organization by
 * organization.
 */
export const InterviewersDoing = ({ view }: { view: OrgView }) => {
  const stats = stephenOf(view);
  if (stats.started === 0) {
    return <EmptySection>{noInterviewsYet(view)}</EmptySection>;
  }
  const { count, average, by } = stats.rating;
  return (
    <Section
      description="At the end of their interview, people can say how it was: from 1 to 5."
      title="What people thought of it"
    >
      <div className="bg-border grid grid-cols-2 gap-px border-t">
        <Figure
          label="Rating"
          sub={
            count === 0
              ? "Nobody has said yet"
              : `${count} of ${stats.held} said how it was`
          }
          value={count === 0 ? "–" : `${decimal(average)} of 5`}
        />
        <Figure
          label="Finished"
          sub="who started also agreed"
          value={`${stats.held} of ${stats.started}`}
        />
      </div>
      {count > 0 ? (
        <div className="border-t px-5 py-4">
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
    </Section>
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
          <p className="border-t px-5 py-4">
            <Attention>
              People there also need {wanted}, which Stephen and Claire don’t
              speak yet.
            </Attention>
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
