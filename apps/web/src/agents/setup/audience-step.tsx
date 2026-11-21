import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { IconTile } from "../../grasp/icon-tile/index.ts";
import { Company, People, Person, Tick } from "../../grasp/icons/index.ts";
import type { IconData } from "../../grasp/icons/index.ts";
import { Text } from "../../grasp/text/index.ts";
import { Toggle, ToggleGroup } from "../../grasp/toggle/index.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import { ChoiceCards } from "./choice-cards.tsx";
import type { Audience, StepProps } from "./model.ts";
import { Question } from "./question.tsx";
import { useSetupWords } from "./words.ts";

// Who may use it, the first question, as three cards to press (Ruben,
// 21 November: the card itself is the choice, no radio dot; the icons, but
// a little more creative): each card its mark and, under its words, how far
// it reaches as a row of dots: one lit for just the maker, some for a few
// teams, all of them for everyone, lit in green on the chosen card. Just me
// only while the company lets people have their own. Some teams brings up
// the company's teams under the cards as toggles, in a row whose room is
// always kept, so the cards never move when it comes or goes.

/** Each choice's mark. */
const marks: Record<Audience, IconData> = {
  me: Person,
  teams: People,
  everyone: Company,
};

/** How many dots the reach has, and how many each choice lights. */
const reachDots = 12;
const reaches: Record<Audience, number> = { me: 1, teams: 5, everyone: 12 };

const styles = stylex.create({
  teams: {
    display: "grid",
    justifyItems: "center",
    gap: grasp.space2,
    minHeight: grasp.controlSm,
  },
  // Out of sight and out of reach until Some teams is chosen, its room kept.
  away: { visibility: "hidden" },
  // How far it reaches: a row of small dots, the lit ones first.
  reach: {
    display: "flex",
    gap: "0.3125rem",
    marginBlockStart: grasp.space2,
  },
  dot: {
    width: "0.375rem",
    height: "0.375rem",
    borderRadius: grasp.cornerCircle,
    backgroundColor: grasp.line,
    transitionProperty: "background-color",
    transitionDuration: grasp.durationUi,
    transitionTimingFunction: grasp.ease,
  },
  lit: { backgroundColor: grasp.muted },
  litChosen: { backgroundColor: grasp.success },
});

/** How far a choice reaches, as dots: lit up to `reach`, in green when it is chosen. */
const Reach = ({ reach, chosen }: { reach: number; chosen: boolean }) => (
  <span aria-hidden="true" {...stylex.props(styles.reach)}>
    {Array.from({ length: reachDots }, (_, at) => (
      <span
        key={at}
        {...stylex.props(
          styles.dot,
          at < reach && (chosen ? styles.litChosen : styles.lit)
        )}
      />
    ))}
  </span>
);

/** The teams to press when some teams may use it. */
const TeamsChoice = ({
  setup,
  change,
  teams,
  shown,
}: Pick<StepProps, "setup" | "change" | "teams"> & { shown: boolean }) => {
  const { t } = useLingui();
  return (
    <div inert={!shown} {...stylex.props(styles.teams, !shown && styles.away)}>
      {teams.length === 0 ? (
        <Text tone="muted">{t`Your company has no teams yet.`}</Text>
      ) : (
        <ToggleGroup
          aria-label={t`Teams`}
          multiple
          onValueChange={(values) => {
            change({ teams: new Set(values) });
          }}
          value={[...setup.teams]}
        >
          {teams.map((team) => (
            <Toggle
              // A tick on each team picked, so the choice reads at a glance.
              icon={setup.teams.has(team.teamId) ? Tick : undefined}
              key={team.teamId}
              value={team.teamId}
            >
              {team.name}
            </Toggle>
          ))}
        </ToggleGroup>
      )}
    </div>
  );
};

export const AudienceStep = ({
  setup,
  change,
  teams,
  audiences,
}: StepProps) => {
  const { t } = useLingui();
  const { audienceNames } = useSetupWords();
  const explained: Record<Audience, string> = {
    me: t`Only you can use it. Share it later.`,
    teams: t`Only the teams you pick.`,
    everyone: t`Anyone in your company.`,
  };
  return (
    <Question title={t`Who can use it?`}>
      <ChoiceCards
        cards={audiences.map((audience) => {
          const chosen = setup.audience === audience;
          return {
            value: audience,
            title: audienceNames[audience],
            description: explained[audience],
            media: (
              <IconTile
                icon={marks[audience]}
                variant={chosen ? "gradient" : "raised"}
              />
            ),
            foot: <Reach chosen={chosen} reach={reaches[audience]} />,
          };
        })}
        label={t`Who can use it`}
        onValueChange={(audience) => {
          change({ audience });
        }}
        value={setup.audience}
      />
      {audiences.includes("teams") ? (
        <TeamsChoice
          change={change}
          setup={setup}
          shown={setup.audience === "teams"}
          teams={teams}
        />
      ) : null}
    </Question>
  );
};
