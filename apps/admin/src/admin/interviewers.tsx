import type { OrgView } from "@grasp-os/shared/admin/onboarding-admin";
import { stephenOf } from "@grasp-os/shared/admin/onboarding-admin-record";
import { RATINGS } from "@grasp-os/shared/admin/org-record";
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
import { Badge } from "@grasp-os/ui/components/badge";
import { CardContent } from "@grasp-os/ui/components/card";
import { StatGroup } from "@grasp-os/ui/components/stat";
import { Text } from "@grasp-os/ui/components/text";
import { colors, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

import { BarList } from "./interview-parts.tsx";
import { noInterviewsYet } from "./interviews.tsx";
import { Attention } from "./marks.tsx";
import { EmptyPanel, Panel, PanelNote } from "./panel.tsx";
import { SetupActions } from "./stephen-setup.tsx";
import type { SetupRead } from "./stephen-setup.tsx";

const styles = stylex.create({
  // A part of the setup, edge to edge under the panel's header, a hairline over it.
  part: {
    display: "flex",
    flexDirection: "column",
    gap: space["3"],
    paddingBlock: space["4"],
    paddingInline: space["5"],
    borderBlockStartWidth: { default: size.hairline, ":first-child": 0 },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
  words: { display: "flex", flexDirection: "column", gap: "0.125rem" },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  badges: { flexDirection: "row", flexWrap: "wrap" },
  lines: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  line: {
    paddingBlock: "0.625rem",
    paddingInline: space["5"],
    borderBlockStartWidth: { default: size.hairline, ":first-child": 0 },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
});

const oneDecimal = new Intl.NumberFormat("en", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
/** An average, to one place. */
const decimal = (value: number): string => oneDecimal.format(value);

/**
 * How Stephen did in this company's interviews, in short: what people
 * thought of it and how many who started also finished, as two figures,
 * then how many gave each rating. The rest (how long it takes, where they
 * stop) is in Stephen Lab, organization by organization.
 */
export const InterviewersDoing = ({ view }: { view: OrgView }) => {
  const stats = stephenOf(view);
  if (stats.started === 0) {
    return <EmptyPanel>{noInterviewsYet(view)}</EmptyPanel>;
  }
  const { count, average, by } = stats.rating;
  return (
    <Panel
      description="At the end of their interview, people can say how it was: from 1 to 5."
      title="What people thought of it"
    >
      <CardContent>
        <StatGroup
          aria-label="What people thought of it"
          columns={2}
          items={[
            {
              label: "Rating",
              value: count === 0 ? "–" : `${decimal(average)} of 5`,
              change:
                count === 0
                  ? "Nobody has said yet"
                  : `${count} of ${stats.held} said how it was`,
            },
            {
              label: "Finished",
              value: `${stats.held} of ${stats.started}`,
              change: "who started also agreed",
            },
          ]}
        />
      </CardContent>
      {count > 0 ? (
        <CardContent>
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
        </CardContent>
      ) : null}
    </Panel>
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
  <div {...stylex.props(styles.part)}>
    <div {...stylex.props(styles.words)}>
      <Text as="span" color="default" size="sm">
        {label}
      </Text>
      <Text color="muted" size="sm">
        {description}
      </Text>
    </div>
    {items.length === 0 ? (
      <Text color="muted" size="sm">
        {none}
      </Text>
    ) : (
      <ul {...stylex.props(styles.list, short && styles.badges)}>
        {items.map((item) => (
          <li key={item}>
            {short ? (
              <Badge variant="outline">{item}</Badge>
            ) : (
              <Text as="span" color="default" size="sm">
                {item}
              </Text>
            )}
          </li>
        ))}
      </ul>
    )}
  </div>
);

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
    <>
      <Panel
        action={<SetupActions clientId={clientId} setup={setupRead} />}
        description={
          setupRead.changed
            ? "As Grasp changed it."
            : "From the first conversation with the sponsor."
        }
        title="How Stephen is set up here"
      >
        <CardContent flush>
          <SetupPart
            description="Someone chooses their own language when they open their link."
            items={setup.languages.map(languageOf)}
            label="Languages he interviews in"
            none="None named yet: the company’s own Grasp doesn’t say which."
            short
          />
          {wanted === "" ? null : (
            <div {...stylex.props(styles.part)}>
              <Text as="span" color="default" size="sm">
                <Attention>
                  People there also need {wanted}, which Stephen doesn’t speak
                  yet.
                </Attention>
              </Text>
            </div>
          )}
          <SetupPart
            description="He doesn’t ask about it, and moves on when somebody brings it up."
            items={setup.limits}
            label="What he leaves alone"
            none="Nothing yet."
          />
          <SetupPart
            description="Tools, products and the company’s own words, so he hears them right."
            items={setup.terms}
            label="Words he has to know"
            none="None yet."
            short
          />
        </CardContent>
      </Panel>
      <Panel
        description="A line each, from the first conversation, the research and what the company connected."
        title="What he knows before he says hello"
      >
        {org.brief.length === 0 ? (
          <PanelNote>Nothing yet.</PanelNote>
        ) : (
          <CardContent flush>
            <ul {...stylex.props(styles.lines)}>
              {org.brief.map((line) => (
                <li key={line} {...stylex.props(styles.line)}>
                  <Text as="span" color="default" size="sm">
                    {line}
                  </Text>
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Panel>
    </>
  );
};
