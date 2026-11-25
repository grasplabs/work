// Concept B, the company in one picture: every person invited is a square,
// each team a block of them standing on one ground line, so how much of
// the company has been heard reads at a glance, and a quiet team shows as
// a block still mostly empty. A team opens beside the picture with what
// we learned there and what it needs from the admin; the page opens on the
// team that needs them most.
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import { colors, media, radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { Asks } from "../campaign-asks.tsx";
import { AllFindings } from "../campaign-findings.tsx";
import {
  declinedWords,
  findingWords,
  rowName,
  runningWords,
  say,
  statementOf,
  talkedWords,
} from "../campaign-words.ts";
import type { Campaign, TeamPicture } from "../fixtures.ts";
import { seatsOf, standingOf } from "../reading.ts";
import type { Seat } from "../reading.ts";
import { forecastWords, standingWords } from "./concept-words.ts";
import { Mark, Seats } from "./seats.tsx";

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    gap: { default: space[12], [media.maxSm]: space[8] },
  },
  opening: {
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    maxWidth: "48rem",
  },
  body: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr) minmax(0, 22rem)",
      [media.maxLg]: "minmax(0, 1fr)",
    },
    columnGap: space[16],
    rowGap: space[10],
    alignItems: "start",
  },
  picture: { display: "flex", flexDirection: "column", gap: space[6] },
  blocks: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    columnGap: space[2],
    rowGap: space[6],
  },
  block: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space[3],
    padding: space[4],
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radius.lg,
    backgroundColor: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "start",
    cursor: "pointer",
    outline: {
      default: "none",
      ":focus-visible": `2px solid ${colors.ring}`,
    },
  },
  chosen: { borderColor: colors.border, backgroundColor: colors.card },
  label: { display: "flex", flexDirection: "column" },
  key: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: space[6],
    rowGap: space[2],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  keyItem: { display: "flex", alignItems: "center", gap: space[2] },
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: space[6],
    position: { default: "sticky", [media.maxLg]: "static" },
    top: space[6],
    paddingInlineStart: { default: space[8], [media.maxLg]: 0 },
    borderInlineStartWidth: { default: 1, [media.maxLg]: 0 },
    borderInlineStartStyle: "solid",
    borderInlineStartColor: colors.border,
  },
  panelHead: { display: "flex", flexDirection: "column", gap: space[1] },
  findings: {
    display: "flex",
    flexDirection: "column",
    gap: space[4],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  foot: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: space[4],
  },
  lines: { display: "flex", flexDirection: "column" },
});

/** The team the page opens on: one the admin is asked about, else a quiet one, else the first. */
const firstChosen = (campaign: Campaign): TeamPicture | undefined =>
  campaign.teams.find((team) =>
    campaign.asks.some((ask) => ask.team === team.name)
  ) ??
  campaign.teams.find((team) => standingOf(team, campaign) === "quiet") ??
  campaign.teams[0];

/** A team's block: its squares, as near square as they pile, and its name under them. */
const Block = ({
  team,
  campaign,
  chosen,
  onChoose,
}: {
  team: TeamPicture;
  campaign: Campaign;
  chosen: boolean;
  onChoose: () => void;
}) => {
  const { i18n } = useLingui();
  const across = Math.max(2, Math.ceil(Math.sqrt(team.invited)));
  return (
    <button
      aria-pressed={chosen}
      onClick={onChoose}
      type="button"
      {...stylex.props(styles.block, chosen && styles.chosen)}
    >
      <Seats across={across} seats={seatsOf(team, campaign)} side={6} />
      <span {...stylex.props(styles.label)}>
        <Text as="span" color="default">
          {say(i18n, rowName(team, campaign.grouped))}
        </Text>
        <Text as="span" color="muted" size="sm">
          {i18n._(talkedWords(team))}
        </Text>
      </span>
    </button>
  );
};

/** What the squares mean. */
const Key = ({ campaign }: { campaign: Campaign }) => {
  const { t } = useLingui();
  const small = campaign.teams.some((team) => team.invited < 5);
  const entries: { seat: Seat; words: string }[] = [
    { seat: "talked", words: t`Talked` },
    { seat: "today", words: t`Talked today` },
    { seat: "waiting", words: t`Still to talk` },
    ...(small
      ? [{ seat: "unseen" as const, words: t`Not shown in a small team` }]
      : []),
  ];
  return (
    <ul aria-label={t`What the squares mean`} {...stylex.props(styles.key)}>
      {entries.map((entry) => (
        <li key={entry.seat} {...stylex.props(styles.keyItem)}>
          <Mark each={entry.seat} size={3} />
          <Text as="span" color="muted" size="sm">
            {entry.words}
          </Text>
        </li>
      ))}
    </ul>
  );
};

/** The chosen team, beside the picture: how it stands, what it needs, what we learned. */
const Panel = ({
  team,
  campaign,
}: {
  team: TeamPicture;
  campaign: Campaign;
}) => {
  const { t, i18n } = useLingui();
  const { grouped } = campaign;
  const asks = campaign.asks.filter((ask) => ask.team === team.name);
  return (
    <aside aria-live="polite" {...stylex.props(styles.panel)}>
      <div {...stylex.props(styles.panelHead)}>
        <Heading level={2} size="sm">
          {say(i18n, rowName(team, grouped))}
        </Heading>
        <Text color="muted">{i18n._(standingWords(team, campaign))}</Text>
      </div>
      {asks.length === 0 ? null : <Asks asks={asks} key={team.id} />}
      {team.findings.length === 0 ? (
        <Text color="muted" size="lg">{t`Nothing learned here yet.`}</Text>
      ) : (
        <ul {...stylex.props(styles.findings)}>
          {team.findings.map((finding) => (
            <li key={finding.id}>
              <Text color="default" size="lg">
                {say(i18n, findingWords(finding, grouped))}
              </Text>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
};

/** The company in one picture, in one state. */
export const Mosaic = ({ campaign }: { campaign: Campaign }) => {
  const { i18n } = useLingui();
  const { lead, rest } = statementOf(campaign);
  const forecast = forecastWords(i18n, campaign);
  const [chosenId, setChosenId] = useState(() => firstChosen(campaign)?.id);
  const chosen =
    campaign.teams.find((team) => team.id === chosenId) ?? campaign.teams[0];
  const declined = declinedWords(campaign);
  return (
    <div {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.opening)}>
        <Heading level={1} size="xl">
          {i18n._(lead)}
        </Heading>
        <Text size="lg">
          {i18n._(rest)}
          {forecast === null ? null : ` ${i18n._(forecast)}`}
        </Text>
      </header>
      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.picture)}>
          <div {...stylex.props(styles.blocks)}>
            {campaign.teams.map((team) => (
              <Block
                campaign={campaign}
                chosen={team.id === chosen?.id}
                key={team.id}
                onChoose={() => {
                  setChosenId(team.id);
                }}
                team={team}
              />
            ))}
          </div>
          <Key campaign={campaign} />
        </div>
        {chosen === undefined ? null : (
          <Panel campaign={campaign} team={chosen} />
        )}
      </div>
      <footer {...stylex.props(styles.foot)}>
        <div {...stylex.props(styles.lines)}>
          <Text color="muted" size="lg">
            {i18n._(runningWords(campaign))}
          </Text>
          {declined === null ? null : (
            <Text color="muted" size="lg">
              {i18n._(declined)}
            </Text>
          )}
        </div>
        <AllFindings campaign={campaign} />
      </footer>
    </div>
  );
};
