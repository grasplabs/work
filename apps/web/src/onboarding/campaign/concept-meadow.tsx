// Concept A, the meadow: the picture says how it goes before a word is
// read. Each person invited is a seed in their team's ground; who has
// talked has flowered; a quiet team is bare; the sky lightens as Grasp
// learns. Under it, centred as the onboarding's steps were, one title and
// one sentence that lights up as it is read; three things Grasp learned;
// what the admin must do only when there is something; one quiet line for
// when. On a phone, the meadow and the sentence alone.
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

import {
  AllFindings,
  AskList,
  NothingYet,
  OnYourComputer,
  RunningLine,
  wide,
} from "./campaign-parts.tsx";
import { statementOf, talkedWords } from "./campaign-words.ts";
import type { Campaign } from "./fixtures.ts";
import { MeadowField } from "./meadow-field.tsx";
import { ReadAloud } from "./read-aloud.tsx";

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: { default: space[12], [media.maxSm]: space[8] },
  },
  full: { alignSelf: "stretch" },
  centre: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space[3],
    maxWidth: "36rem",
    textAlign: "center",
    textWrap: "balance",
  },
  three: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: space[10],
    alignSelf: "stretch",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  finding: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space[2],
    textAlign: "center",
  },
  asks: { alignSelf: "stretch", maxWidth: "40rem", marginInline: "auto" },
});

/** The first finding of each team, up to three: one look across the company. */
const firstThree = (campaign: Campaign) =>
  campaign.teams
    .flatMap((each) =>
      campaign.grouped
        ? each.findings.slice(0, 1).map((finding) => ({ finding, team: each }))
        : each.findings.map((finding) => ({ finding, team: each }))
    )
    .slice(0, 3);

/** Concept A: the campaign page as the meadow it grows. */
export const CampaignMeadow = ({ campaign }: { campaign: Campaign }) => {
  const { lead, rest } = statementOf(campaign);
  const three = firstThree(campaign);
  const label = campaign.grouped
    ? `A meadow of everyone invited: ${campaign.teams
        .map((each) => `${each.name}, ${talkedWords(each, true)}`)
        .join("; ")}.`
    : `A meadow of everyone invited: ${rest}`;
  return (
    <div {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.full)}>
        <MeadowField campaign={campaign} label={label} />
      </div>
      <header {...stylex.props(styles.centre)}>
        <Heading level={1} size="xl">
          {lead}
        </Heading>
        <Text size="lg">
          <ReadAloud text={rest} />
        </Text>
      </header>
      <OnYourComputer />
      {three.length === 0 ? (
        <div {...stylex.props(wide.only)}>
          <NothingYet />
        </div>
      ) : (
        <div {...stylex.props(wide.only)}>
          <ul aria-label="What we learned" {...stylex.props(styles.three)}>
            {three.map(({ finding, team }) => (
              <li key={finding.id} {...stylex.props(styles.finding)}>
                <Text as="span" size="xs" color="muted">
                  {campaign.grouped ? team.name : finding.topic}
                </Text>
                <Text size="lg" variant="display">
                  {finding.text}
                </Text>
              </li>
            ))}
          </ul>
        </div>
      )}
      {campaign.asks.length === 0 ? null : (
        <div {...stylex.props(wide.only)}>
          <div {...stylex.props(styles.asks)}>
            <AskList campaign={campaign} />
          </div>
        </div>
      )}
      <div {...stylex.props(wide.only)}>
        <div {...stylex.props(styles.centre)}>
          <RunningLine campaign={campaign} />
          <AllFindings campaign={campaign} variant="outline" />
        </div>
      </div>
    </div>
  );
};
