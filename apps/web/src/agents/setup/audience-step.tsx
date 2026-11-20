import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { Card } from "../../grasp/card/index.ts";
import { Checkbox } from "../../grasp/checkbox/index.ts";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "../../grasp/field/index.ts";
import { IconTile } from "../../grasp/icon-tile/index.ts";
import { Company, People, Person } from "../../grasp/icons/index.ts";
import type { IconData } from "../../grasp/icons/index.ts";
import { RadioGroup, RadioGroupItem } from "../../grasp/radio-group/index.ts";
import { Text } from "../../grasp/text/index.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import { toggled } from "./model.ts";
import type { Audience, StepProps } from "./model.ts";
import { Question } from "./question.tsx";
import { useSetupWords } from "./words.ts";

// Who may use it, the first question, as three cards side by side: just
// the maker (an agent of their own, which they may offer the company
// later), some teams, or everyone. Just me only while the company lets
// people have their own. One Radio group; each card is a Field row with its
// radio, so a press anywhere on it chooses it. The chosen card stands
// raised with the view's one gradient mark, the others lie soft. Some
// teams opens the teams to tick under the cards.

/** Each choice's mark. */
const marks: Record<Audience, IconData> = {
  me: Person,
  teams: People,
  everyone: Company,
};

const styles = stylex.create({
  // Three a row, one when narrow.
  cards: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(auto-fit, minmax(0, 1fr))",
      "@media (width < 40rem)": "minmax(0, 1fr)",
    },
    gap: grasp.space3,
  },
  inside: { display: "grid", justifyItems: "start", gap: grasp.space2 },
  teams: { display: "grid", gap: grasp.space2 },
});

/** The teams to tick when some teams may use it. */
const TeamsChoice = ({
  setup,
  change,
  teams,
}: Pick<StepProps, "setup" | "change" | "teams">) => {
  const { t } = useLingui();
  if (teams.length === 0) {
    return <Text tone="muted">{t`Your company has no teams yet.`}</Text>;
  }
  return (
    <div {...stylex.props(styles.teams)}>
      {teams.map((team) => (
        <Field key={team.teamId} orientation="horizontal">
          <Checkbox
            checked={setup.teams.has(team.teamId)}
            onCheckedChange={(on) => {
              change({
                teams: toggled(setup.teams, team.teamId, on === true),
              });
            }}
          />
          <FieldContent>
            <FieldLabel>{team.name}</FieldLabel>
          </FieldContent>
        </Field>
      ))}
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
      <RadioGroup
        aria-label={t`Who can use it`}
        onValueChange={(value) => {
          const audience = audiences.find((each) => each === value);
          if (audience !== undefined) {
            change({ audience });
          }
        }}
        value={setup.audience}
      >
        <div {...stylex.props(styles.cards)}>
          {audiences.map((audience) => {
            const chosen = setup.audience === audience;
            return (
              <Card key={audience} variant={chosen ? "raised" : "soft"}>
                {/* The radio first, then its words, as a horizontal Field has them. */}
                <Field orientation="horizontal">
                  <RadioGroupItem value={audience} />
                  <FieldContent>
                    <span {...stylex.props(styles.inside)}>
                      <IconTile
                        icon={marks[audience]}
                        variant={chosen ? "gradient" : "raised"}
                      />
                      <FieldLabel>{audienceNames[audience]}</FieldLabel>
                      <FieldDescription>{explained[audience]}</FieldDescription>
                    </span>
                  </FieldContent>
                </Field>
              </Card>
            );
          })}
        </div>
      </RadioGroup>
      {setup.audience === "teams" ? (
        <TeamsChoice change={change} setup={setup} teams={teams} />
      ) : null}
    </Question>
  );
};
