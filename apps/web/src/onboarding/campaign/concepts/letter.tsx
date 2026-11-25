// Concept A, the letter: the progress page read top to bottom as a short
// note from Grasp, in the order an admin asks. Is it going well, and where
// is it heading by the close? Does anything need me? What have we learned
// that I didn't know? How does each team stand? What happens after? One
// reading column; the pictures are small and serve the words.
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { Asks } from "../campaign-asks.tsx";
import { AllFindings } from "../campaign-findings.tsx";
import {
  declinedWords,
  findingWords,
  rowName,
  say,
  statementOf,
  talkedWords,
} from "../campaign-words.ts";
import type { Campaign } from "../fixtures.ts";
import { seatsOf, strikingOf } from "../reading.ts";
import {
  forecastWords,
  milestonesOf,
  nothingForYou,
  standingWords,
  todayWords,
} from "./concept-words.ts";
import { Mark, Seats } from "./seats.tsx";

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    gap: { default: space[16], [media.maxSm]: space[10] },
    maxWidth: "46rem",
  },
  opening: { display: "flex", flexDirection: "column", gap: space[4] },
  section: { display: "flex", flexDirection: "column", gap: space[6] },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space[8],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  finding: { display: "flex", flexDirection: "column", gap: space[2] },
  teams: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 10rem) auto minmax(0, 1fr)",
      [media.maxSm]: "minmax(0, 1fr) auto",
    },
    alignItems: "center",
    columnGap: space[6],
    rowGap: space[5],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  team: { display: "contents" },
  name: { display: "flex", flexDirection: "column", minWidth: 0 },
  standing: { display: { default: "block", [media.maxSm]: "none" } },
  steps: {
    display: "flex",
    flexDirection: "column",
    gap: space[4],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  step: {
    display: "grid",
    gridTemplateColumns: "1rem minmax(0, 8rem) minmax(0, 1fr)",
    alignItems: "baseline",
    columnGap: space[4],
  },
  marker: { alignSelf: "center" },
  foot: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: space[4],
  },
});

/** The letter, in one state. */
export const Letter = ({ campaign }: { campaign: Campaign }) => {
  const { t, i18n } = useLingui();
  const { lead, rest } = statementOf(campaign);
  const forecast = forecastWords(i18n, campaign);
  const { grouped } = campaign;
  const striking = strikingOf(campaign, 3);
  const declined = declinedWords(campaign);
  const across = Math.max(...campaign.teams.map((team) => team.invited));
  return (
    <article {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.opening)}>
        <Text color="muted">{i18n._(todayWords(i18n, campaign))}</Text>
        <Heading level={1} size="xl">
          {i18n._(lead)}
        </Heading>
        <Text size="lg">
          {i18n._(rest)}
          {forecast === null ? null : ` ${i18n._(forecast)}`}
        </Text>
      </header>

      <section {...stylex.props(styles.section)}>
        <Heading level={2} size="xs">
          {t`For you`}
        </Heading>
        {campaign.asks.length === 0 ? (
          <Text color="muted" size="lg">
            {i18n._(nothingForYou)}
          </Text>
        ) : (
          <Asks asks={campaign.asks} />
        )}
      </section>

      <section {...stylex.props(styles.section)}>
        <Heading level={2} size="xs">
          {t`What stood out`}
        </Heading>
        {striking.length === 0 ? (
          <Text color="muted" size="lg">
            {t`Nothing learned yet. The first findings come tomorrow.`}
          </Text>
        ) : (
          <ul {...stylex.props(styles.list)}>
            {striking.map(({ team, finding }) => (
              <li key={finding.id} {...stylex.props(styles.finding)}>
                {grouped ? (
                  <Text color="muted" size="sm">
                    {team.name}
                  </Text>
                ) : null}
                <Heading level={3} size="sm">
                  {say(i18n, findingWords(finding, grouped))}
                </Heading>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section {...stylex.props(styles.section)}>
        <Heading level={2} size="xs">
          {grouped ? t`Team by team` : t`Who has talked`}
        </Heading>
        <ul {...stylex.props(styles.teams)}>
          {campaign.teams.map((team) => (
            <li key={team.id} {...stylex.props(styles.team)}>
              <span {...stylex.props(styles.name)}>
                <Text as="span" color="default" truncate>
                  {say(i18n, rowName(team, grouped))}
                </Text>
                <Text as="span" color="muted" size="sm" truncate>
                  {i18n._(talkedWords(team))}
                </Text>
              </span>
              <Seats
                across={across}
                seats={seatsOf(team, campaign)}
                wide={across}
              />
              <span {...stylex.props(styles.standing)}>
                <Text as="span" color="muted" size="sm">
                  {i18n._(standingWords(team, campaign))}
                </Text>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section {...stylex.props(styles.section)}>
        <Heading level={2} size="xs">
          {t`What happens next`}
        </Heading>
        <ol {...stylex.props(styles.steps)}>
          {milestonesOf(i18n, campaign).map((step) => {
            let seat: "talked" | "today" | "waiting" = "waiting";
            if (step.state === "done") {
              seat = "talked";
            } else if (step.state === "now") {
              seat = "today";
            }
            return (
              <li key={step.id} {...stylex.props(styles.step)}>
                <span {...stylex.props(styles.marker)}>
                  <Mark each={seat} />
                </span>
                <Text as="span" color="muted">
                  {say(i18n, step.when)}
                </Text>
                <Text
                  as="span"
                  color={step.state === "later" ? "muted" : "default"}
                >
                  {i18n._(step.what)}
                </Text>
              </li>
            );
          })}
        </ol>
      </section>

      <footer {...stylex.props(styles.foot)}>
        <Text color="muted">{declined === null ? "" : i18n._(declined)}</Text>
        <AllFindings campaign={campaign} />
      </footer>
    </article>
  );
};
