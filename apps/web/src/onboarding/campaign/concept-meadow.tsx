// Concept A, the meadow: the picture says how it goes before a word is
// read. Each person invited is a seed in their team's ground; who has
// talked has flowered; a quiet team is bare; the sky lightens as Grasp
// learns. Under it, in one column at its start, one title and one
// sentence; three things Grasp learned, each one plain sentence;
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
import { findingSentence, statementOf, talkedWords } from "./campaign-words.ts";
import type { Campaign } from "./fixtures.ts";
import { MeadowField } from "./meadow-field.tsx";

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    gap: { default: space[10], [media.maxSm]: space[8] },
  },
  // Everything under the picture reads in one column at its start.
  column: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space[3],
    maxWidth: "40rem",
  },
  three: {
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    maxWidth: "40rem",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  asks: { maxWidth: "40rem" },
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
      <MeadowField campaign={campaign} label={label} />
      <header {...stylex.props(styles.column)}>
        <Heading level={1} size="xl">
          {lead}
        </Heading>
        <Text>{rest}</Text>
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
              <li key={finding.id}>
                <Text>
                  {findingSentence(finding, team, {
                    named: true,
                    grouped: campaign.grouped,
                  })}
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
        <div {...stylex.props(styles.column)}>
          <RunningLine campaign={campaign} />
          <AllFindings campaign={campaign} variant="outline" />
        </div>
      </div>
    </div>
  );
};
