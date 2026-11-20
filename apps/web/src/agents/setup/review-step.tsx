import type { I18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { modelName } from "../../chat/model-names.tsx";
import { ProviderMark } from "../../connections/provider-mark.tsx";
import { formatList } from "../../format.ts";
import {
  AgentFigure,
  AgentFigureAura,
} from "../../grasp/agent-figure/index.ts";
import { Badge } from "../../grasp/badge/index.ts";
import { Card, CardDescription } from "../../grasp/card/index.ts";
import { Heading } from "../../grasp/heading/index.ts";
import { KeyValueList } from "../../grasp/key-value/index.ts";
import { Text } from "../../grasp/text/index.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import { lookFromName } from "../figure/look.ts";
import { abilities } from "./model.ts";
import type { Schedule, StepProps } from "./model.ts";
import { Question } from "./question.tsx";
import { useSetupWords } from "./words.ts";

// The last look before it is made: the agent's card as the Agents page
// draws it (its night, its figure large and cropped by the corner, its
// name and job), opened out with everything the setup said, each a row.

const styles = stylex.create({
  // The portrait beside its details; one above the other when narrow.
  card: {
    display: "grid",
    gridTemplateColumns: {
      default: "16rem minmax(0, 1fr)",
      "@media (width < 40rem)": "minmax(0, 1fr)",
    },
    textAlign: "start",
  },
  // As the Agents page's card: the agent's light on the page's own ground.
  portrait: {
    position: "relative",
    display: "grid",
    alignContent: "start",
    minHeight: "18rem",
    padding: grasp.space5,
    overflow: "hidden",
    isolation: "isolate",
  },
  figure: {
    position: "absolute",
    insetBlockEnd: "-3.5rem",
    insetInlineEnd: "-3.5rem",
    zIndex: 0,
  },
  words: {
    position: "relative",
    zIndex: 1,
    display: "grid",
    gap: grasp.space2,
  },
  details: { padding: grasp.space5 },
  marks: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
  },
  app: { display: "inline-flex", alignItems: "center", gap: grasp.space2 },
});

/** A weekday's name: a known Sunday (4 Jan 2026) and the days after it. */
const weekdayName = (day: number, i18n: I18n): string =>
  new Intl.DateTimeFormat(i18n.locale, { weekday: "long" }).format(
    new Date(Date.UTC(2026, 0, 4 + day, 12))
  );

/** When it works, in a few words: "Every Monday and Friday at 09:00". */
const useScheduleLine = () => {
  const { t, i18n } = useLingui();
  const words = useSetupWords();
  return (schedule: Schedule): string => {
    const { time } = schedule;
    if (schedule.frequency === "daily") {
      return t`Every day at ${time}`;
    }
    if (schedule.frequency === "monthly") {
      const day = schedule.dayOfMonth;
      return t`Day ${day} of every month at ${time}`;
    }
    if (schedule.frequency === "weekly") {
      const days = formatList(
        [...schedule.days]
          .toSorted((a, b) => a - b)
          .map((day) => weekdayName(day, i18n))
      );
      return t`Every ${days} at ${time}`;
    }
    return words.frequencyNames.asked;
  };
};

export const ReviewStep = ({ setup, name, apps, teams }: StepProps) => {
  const { t } = useLingui();
  const words = useSetupWords();
  const scheduleLine = useScheduleLine();
  const look = lookFromName(name);
  const chosenApps = apps.filter(({ id }) => setup.apps.has(id));
  const chosenTeams = teams.filter(({ teamId }) => setup.teams.has(teamId));
  const thinksWith =
    setup.model === null
      ? t`The model picked in the chat`
      : modelName(setup.model);
  const effort = words.effortNames[setup.effort];
  return (
    <Question
      line={t`You can change all of this later.`}
      title={t`Ready to make ${name}?`}
    >
      <Card padding="none">
        <div {...stylex.props(styles.card)}>
          <div {...stylex.props(styles.portrait)}>
            <AgentFigureAura ground="page" look={look} />
            <span {...stylex.props(styles.figure)}>
              <AgentFigure look={look} size="xl" state="done" />
            </span>
            <span {...stylex.props(styles.words)}>
              <Heading level={2} size="md">
                {name}
              </Heading>
              <CardDescription>{setup.job}</CardDescription>
            </span>
          </div>
          <div {...stylex.props(styles.details)}>
            <KeyValueList
              items={[
                {
                  key: t`Goal`,
                  value: setup.goal.trim() === "" ? setup.job : setup.goal,
                },
                {
                  key: t`Apps`,
                  value:
                    chosenApps.length === 0 ? (
                      t`None yet`
                    ) : (
                      <span {...stylex.props(styles.marks)}>
                        {chosenApps.map((app) => (
                          <span key={app.id} {...stylex.props(styles.app)}>
                            <ProviderMark
                              id={app.id}
                              logo={app.logo}
                              name={app.name}
                              size="sm"
                            />
                            <Text element="span" size="sm">
                              {app.name}
                            </Text>
                          </span>
                        ))}
                      </span>
                    ),
                },
                {
                  key: t`Can do`,
                  value: (
                    <span {...stylex.props(styles.marks)}>
                      {abilities
                        .filter((ability) => setup.abilities.has(ability))
                        .map((ability) => (
                          <Badge key={ability} size="sm" tone="neutral">
                            {words.abilityNames[ability].label}
                          </Badge>
                        ))}
                    </span>
                  ),
                },
                { key: t`Thinking`, value: `${thinksWith} · ${effort}` },
                {
                  key: t`Works`,
                  value: scheduleLine(setup.schedule),
                },
                {
                  key: t`Who can use it`,
                  value:
                    setup.audience === "teams"
                      ? formatList(chosenTeams.map((team) => team.name))
                      : words.audienceNames[setup.audience],
                },
              ]}
              valueAlign="start"
              variant="inline"
            />
          </div>
        </div>
      </Card>
    </Question>
  );
};
