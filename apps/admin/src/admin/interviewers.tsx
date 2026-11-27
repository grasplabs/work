/**
 * Stephen at one organization, ported from the prototype
 * (grasplabs/prototype `components/admin/org-stephen.tsx`): two of the
 * Interviews section's tabs. How he did there, as the model counts it
 * (`stephenOf`): what the people who talked to him thought of it, and how
 * many who started also finished. And how he is set up for the company.
 *
 * His setup is changed from here (stephen-setup.tsx), kept in the
 * company's Grasp. Not here, as the prototype has it: what a review of
 * each interview found (core runs no such review, so the model says none
 * is `reviewed`).
 */
import type { OrgView } from "@grasp-os/shared/admin/onboarding-admin";
import { stephenOf } from "@grasp-os/shared/admin/onboarding-admin-record";
import { RATINGS } from "@grasp-os/shared/admin/org-record";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { ChartBarList } from "@grasp-os/ui/components/chart";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
} from "@grasp-os/ui/components/item";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import {
  Section as Part,
  SectionHeader,
} from "@grasp-os/ui/components/section-header";
import { Stat, StatGroup } from "@grasp-os/ui/components/stat";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { noInterviewsYet } from "./interviews.tsx";
import { SetupActions } from "./stephen-setup.tsx";
import type { SetupRead } from "./stephen-setup.tsx";

const styles = stylex.create({
  // The page's parts, a step further apart than the lines within each.
  parts: { display: "flex", flexDirection: "column", gap: space["10"] },
  part: { display: "flex", flexDirection: "column", gap: space["4"] },
  badges: { display: "flex", flexWrap: "wrap", gap: space["2"] },
  lines: { display: "flex", flexDirection: "column", gap: space["1"] },
});

const oneDecimal = new Intl.NumberFormat("en", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
/** An average, to one place. */
const decimal = (value: number): string => oneDecimal.format(value);

/** Nothing to show yet, in a sentence. */
const Quiet = ({ children }: { children: string }) => (
  <Empty align="start" size="sm">
    <EmptyHeader>
      <EmptyDescription>{children}</EmptyDescription>
    </EmptyHeader>
  </Empty>
);

/** Each rating as its bar says it: the ends named. */
const ratingWords = (rating: number): string => {
  if (rating === 5) {
    return "5, very good";
  }
  return rating === 1 ? "1, not good" : String(rating);
};

/**
 * How Stephen did in this company's interviews, in short: what people
 * thought of it and how many who started also finished, as two figures,
 * then how many gave each rating. The rest (how long it takes, where they
 * stop) is in Stephen Lab, organization by organization. Counts only.
 */
export const InterviewersDoing = ({ view }: { view: OrgView }) => {
  const stats = stephenOf(view);
  if (stats.started === 0) {
    return <Quiet>{noInterviewsYet(view)}</Quiet>;
  }
  const { count, average, by } = stats.rating;
  return (
    <Part aria-labelledby="thought">
      <SectionHeader
        description="At the end of their interview, people can say how it was: from 1 to 5."
        id="thought"
        title="What people thought of it"
        variant="group"
      />
      <div {...stylex.props(styles.part)}>
        <StatGroup aria-label="What people thought of it" columns={2}>
          <Stat
            change={
              count === 0
                ? "Nobody has said yet"
                : `${count} of ${stats.held} said how it was`
            }
            label="Rating"
            value={count === 0 ? "None yet" : `${decimal(average)} of 5`}
          />
          <Stat
            change="who started also agreed"
            label="Finished"
            value={`${stats.held} of ${stats.started}`}
          />
        </StatGroup>
        {count > 0 ? (
          <ChartBarList
            aria-label="How many gave each"
            config={{ people: { label: "People" } }}
            data={RATINGS.toReversed().map((rating) => ({
              rating: ratingWords(rating),
              people: by[rating] ?? 0,
            }))}
            nameKey="rating"
            sortOrder="none"
            summary={`${count} people said how it was: ${decimal(average)} of 5 on average.`}
          />
        ) : null}
      </div>
    </Part>
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

/** What one part of the setup holds, as Badges or lines; what it says while it holds nothing. */
const held = (
  items: readonly string[],
  none: string,
  short: boolean
): ReactNode => {
  if (items.length === 0) {
    return none;
  }
  return short ? (
    <span {...stylex.props(styles.badges)}>
      {items.map((item) => (
        <Badge key={item} variant="outline">
          {item}
        </Badge>
      ))}
    </span>
  ) : (
    <span {...stylex.props(styles.lines)}>
      {items.map((item) => (
        <span key={item}>{item}</span>
      ))}
    </span>
  );
};

/** How Stephen is set up for this company: a tab of the interviews. */
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
    <div {...stylex.props(styles.parts)}>
      <Part aria-labelledby="set-up">
        <SectionHeader
          actions={<SetupActions clientId={clientId} setup={setupRead} />}
          description={
            setupRead.changed
              ? "As Grasp changed it."
              : "From the first conversation with the sponsor."
          }
          id="set-up"
          title="How Stephen is set up here"
          variant="group"
        />
        <div {...stylex.props(styles.part)}>
          {wanted === "" ? null : (
            <Alert live="off" variant="warning">
              <AlertDescription>
                {`People there also need ${wanted}, which Stephen doesn’t speak yet.`}
              </AlertDescription>
            </Alert>
          )}
          <KeyValueList
            divided
            items={[
              {
                id: "languages",
                label: "Languages he interviews in",
                value: held(
                  setup.languages.map(languageOf),
                  "None named yet: the company’s own Grasp doesn’t say which.",
                  true
                ),
              },
              {
                id: "limits",
                label: "What he leaves alone",
                value: held(setup.limits, "Nothing yet.", false),
              },
              {
                id: "terms",
                label: "Words he has to know",
                value: held(setup.terms, "None yet.", true),
              },
            ]}
          />
        </div>
      </Part>
      <Part aria-labelledby="knows">
        <SectionHeader
          description="A line each, from the first conversation, the research and what the company connected."
          id="knows"
          title="What he knows before he says hello"
          variant="group"
        />
        {org.brief.length === 0 ? (
          <Quiet>Nothing yet.</Quiet>
        ) : (
          <ItemGroup aria-labelledby="knows" separated>
            {org.brief.map((line) => (
              <Item key={line} size="sm">
                <ItemContent>
                  <ItemDescription>{line}</ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        )}
      </Part>
    </div>
  );
};
