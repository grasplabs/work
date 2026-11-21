import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
} from "../../grasp/avatar/index.ts";
import { Tick } from "../../grasp/icons/index.ts";
import { Text } from "../../grasp/text/index.ts";
import { Toggle, ToggleGroup } from "../../grasp/toggle/index.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import { ChoiceCards } from "./choice-cards.tsx";
import type { Audience, StepProps } from "./model.ts";
import { Question } from "./question.tsx";
import { useSetupWords } from "./words.ts";

// Who may use it, the first question, as three cards to press (Ruben,
// 21 November: the card itself is the choice, no radio dot; be creative),
// each picturing who: the person's own face, a few of the company's teams
// as a stack of faces, or the whole company, its teams and "+N". Just the
// maker (an agent of their own, which they may offer the company later),
// some teams, or everyone. Just me only while the company lets people
// have their own. Some teams brings up the company's teams under the
// cards as chips to press, in a row whose room is always kept, so the
// cards never move when it comes or goes.

const styles = stylex.create({
  teams: {
    display: "grid",
    justifyItems: "center",
    gap: grasp.space2,
    minHeight: grasp.controlSm,
  },
  // The faces stand a little apart from the words, at one height on every card.
  faces: { display: "flex", alignItems: "center", minHeight: "2.5rem" },
  // Out of sight and out of reach until Some teams is chosen, its room kept.
  away: { visibility: "hidden" },
});

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
  people,
  me,
  audiences,
}: StepProps) => {
  const { t } = useLingui();
  const { audienceNames } = useSetupWords();
  // The company's people as faces: a few for some teams, all for everyone.
  const crowd = people.map((person) => ({ name: person }));
  // Who each choice reaches, as faces: one, a few teams, or all of them.
  const faces: Record<Audience, React.ReactNode> = {
    me: (
      <Avatar name={me} size="md">
        <AvatarFallback />
      </Avatar>
    ),
    teams: <AvatarGroup max={3} people={crowd.slice(0, 3)} size="md" />,
    everyone: <AvatarGroup max={4} people={crowd} size="md" />,
  };
  const explained: Record<Audience, string> = {
    me: t`Only you can use it. Share it later.`,
    teams: t`Only the teams you pick.`,
    everyone: t`Anyone in your company.`,
  };
  return (
    <Question title={t`Who can use it?`}>
      <ChoiceCards
        cards={audiences.map((audience) => ({
          value: audience,
          title: audienceNames[audience],
          description: explained[audience],
          media: <span {...stylex.props(styles.faces)}>{faces[audience]}</span>,
        }))}
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
