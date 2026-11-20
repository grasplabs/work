import { agentJobMax } from "@grasp-os/shared/agents";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import {
  CardDescription,
  CardLink,
  CardTitle,
} from "../../grasp/card/index.ts";
import { Field } from "../../grasp/field/index.ts";
import { Icon } from "../../grasp/icons/index.ts";
import { Input } from "../../grasp/input/index.ts";
import { Text } from "../../grasp/text/index.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import { templatesFor } from "../agent-templates.ts";
import type { StepProps } from "./model.ts";
import { Question } from "./question.tsx";

// What it should do: the starting points that suit its name, as cards
// (a press takes one and goes on), or the person's own line.

/** How many starting points it shows: the ones the name suits best. */
const cardsShown = 4;

const styles = stylex.create({
  // Two a row, one when narrow.
  cards: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      "@media (width < 40rem)": "minmax(0, 1fr)",
    },
    gap: grasp.space3,
  },
  card: {
    display: "grid",
    justifyItems: "start",
    gap: grasp.space2,
    textAlign: "start",
  },
});

export const JobStep = ({ setup, change, name, pick }: StepProps) => {
  const { t, i18n } = useLingui();
  return (
    <Question
      line={t`Pick one, or write it in one line.`}
      title={t`What should ${name} do?`}
    >
      <div {...stylex.props(styles.cards)}>
        {templatesFor(name)
          .slice(0, cardsShown)
          .map((template) => (
            <CardLink
              key={template.key}
              render={
                <button
                  aria-label={i18n._(template.label)}
                  onClick={() => {
                    pick(template);
                  }}
                  type="button"
                />
              }
            >
              <span {...stylex.props(styles.card)}>
                <Icon icon={template.icon} />
                <CardTitle>{i18n._(template.label)}</CardTitle>
                <CardDescription>
                  {i18n._(template.description)}
                </CardDescription>
                <Text size="sm" tone="muted">
                  {`${i18n._(template.cadence)} → ${i18n._(template.outcome)}`}
                </Text>
              </span>
            </CardLink>
          ))}
      </div>
      <Field>
        <Input
          aria-label={t`What it is for`}
          autoComplete="off"
          autoFocus
          maxLength={agentJobMax}
          onValueChange={(value) => {
            change({ job: value, template: undefined });
          }}
          placeholder={t`Or write it yourself`}
          size="lg"
          value={setup.job}
        />
      </Field>
    </Question>
  );
};
