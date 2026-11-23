import { Card, CardDescription } from "@grasp-os/ui/components/card";
import { Heading } from "@grasp-os/ui/components/heading";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import { media, radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import type { I18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { modelName } from "../../chat/composer.tsx";
import { formatList } from "../../format.ts";
import { AppMark } from "../app-mark.tsx";
import { AgentFigure, AgentFigureAura } from "../figure/agent-figure.tsx";
import { lookFromName } from "../figure/look.ts";
import { abilities } from "./model.ts";
import type { Schedule, StepProps } from "./model.ts";
import { Question } from "./question.tsx";
import { useSetupWords } from "./words.ts";

// The last look before it is made (Ruben, 21 November: one wide card, its
// corners round, less cluttered): the agent's portrait as the Agents page
// draws it (its light, its figure large and cropped by the corner, its
// name and job) and, in the same card, what the setup said, each name
// over its value in plain words: its apps as their marks, what it can do
// in one line, how it thinks, when it works and who can use it.

const styles = stylex.create({
  // The portrait beside its facts, clipped to the card's round corners;
  // one above the other when narrow.
  card: {
    display: "grid",
    gridTemplateColumns: {
      default: "15rem minmax(0, 1fr)",
      [media.maxSm]: "minmax(0, 1fr)",
    },
    borderRadius: radius.base,
    cornerShape: radius.shape,
    overflow: "clip",
    textAlign: "start",
  },
  portrait: {
    position: "relative",
    display: "grid",
    alignContent: "start",
    minHeight: "17rem",
    padding: space["6"],
    overflow: "hidden",
    isolation: "isolate",
  },
  figure: {
    position: "absolute",
    insetBlockEnd: "-3rem",
    insetInlineEnd: "-3rem",
    zIndex: 0,
  },
  words: {
    position: "relative",
    zIndex: 1,
    display: "grid",
    gap: space["2"],
  },
  facts: { alignSelf: "center", padding: space["6"] },
  marks: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
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
  const own = setup.audience === "me";
  const can = formatList(
    abilities
      .filter((ability) => setup.abilities.has(ability))
      .map((ability) => words.abilityNames[ability].label)
  );
  const who =
    setup.audience === "teams"
      ? formatList(chosenTeams.map((team) => team.name))
      : words.audienceNames[setup.audience];
  const goal = setup.goal.trim();
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
              <Heading level={2} size="default">
                {name}
              </Heading>
              <CardDescription>{setup.job}</CardDescription>
            </span>
          </div>
          <div {...stylex.props(styles.facts)}>
            <KeyValueList
              items={[
                // Only a goal the job doesn't say already.
                ...(goal === "" || goal === setup.job.trim()
                  ? []
                  : [{ id: "goal", label: t`Goal`, value: goal }]),
                {
                  id: "apps",
                  label: t`Apps`,
                  value:
                    chosenApps.length === 0 ? (
                      t`None yet`
                    ) : (
                      <span {...stylex.props(styles.marks)}>
                        {chosenApps.map((app) => (
                          <AppMark
                            key={app.id}
                            logo={app.logo}
                            name={app.name}
                          />
                        ))}
                      </span>
                    ),
                },
                // One of their own has no kinds of work or schedule of its own.
                ...(own || can === ""
                  ? []
                  : [{ id: "can", label: t`Can do`, value: can }]),
                {
                  id: "thinking",
                  label: t`Thinking`,
                  value: `${thinksWith} · ${effort}`,
                },
                ...(own
                  ? []
                  : [
                      {
                        id: "works",
                        label: t`Works`,
                        value: scheduleLine(setup.schedule),
                      },
                    ]),
                { id: "who", label: t`Who can use it`, value: who },
              ]}
              orientation="vertical"
              valueAlign="start"
            />
          </div>
        </div>
      </Card>
    </Question>
  );
};
