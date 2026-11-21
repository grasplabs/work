import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { modelName } from "../../chat/model-names.tsx";
import { Badge } from "../../grasp/badge/index.ts";
import { BrandIcon } from "../../grasp/brand-icon/index.ts";
import type { Brand } from "../../grasp/brand-icon/index.ts";
import { Card } from "../../grasp/card/index.ts";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "../../grasp/field/index.ts";
import { Heading } from "../../grasp/heading/index.ts";
import { IconTile } from "../../grasp/icon-tile/index.ts";
import { Sparkles } from "../../grasp/icons/index.ts";
import { LevelSlider } from "../../grasp/level-slider/index.ts";
import { RadioGroup, RadioGroupItem } from "../../grasp/radio-group/index.ts";
import { Text } from "../../grasp/text/index.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import { efforts } from "./model.ts";
import type { Effort, StepProps } from "./model.ts";
import { Question } from "./question.tsx";
import { useSetupWords } from "./words.ts";

// How hard it thinks, in one go: which model it uses, as cards with each
// maker's mark (or the one the person picks in the chat), and how much
// effort it puts in, on the library's Level slider in the same panel,
// with a plain line under it saying what that level means. One Radio
// group for the model; the chosen card stands raised, the others soft.

/** The value of "the one the person picks in the chat" among the cards. */
const askersOwn = "asker";

/** The library's mark for each maker, by the first part of a model's id. */
const makerMarks: Record<string, Brand> = {
  anthropic: "claude",
  openai: "chatgpt",
  google: "gemini",
  mistral: "mistral",
};

/** Who makes `model`: the first part of its id. */
const makerOf = (model: string): string => model.split("/")[0] ?? "";

const styles = stylex.create({
  panel: { display: "grid", gap: grasp.space6 },
  part: { display: "grid", gap: grasp.space3 },
  // Two a row, one when narrow.
  cards: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      "@media (width < 40rem)": "minmax(0, 1fr)",
    },
    gap: grasp.space3,
  },
  inside: { display: "flex", alignItems: "center", gap: grasp.space3 },
  effort: { display: "grid", gap: grasp.space3 },
});

/** One model's card: its mark, its name, its line, and its radio. */
const ModelCard = ({
  value,
  chosen,
  label,
  line,
  brand,
}: {
  value: string;
  chosen: boolean;
  label: string;
  line: string;
  brand: Brand | undefined;
}) => (
  <Card variant={chosen ? "raised" : "soft"}>
    {/* The radio first, its words after it: a horizontal Field's order. */}
    <Field orientation="horizontal">
      <RadioGroupItem value={value} />
      <FieldContent>
        <span {...stylex.props(styles.inside)}>
          {brand === undefined ? (
            <IconTile icon={Sparkles} size="sm" variant="tint" />
          ) : (
            <BrandIcon brand={brand} decorative tile />
          )}
          <span>
            <FieldLabel>{label}</FieldLabel>
            <FieldDescription>{line}</FieldDescription>
          </span>
        </span>
      </FieldContent>
    </Field>
  </Card>
);

export const ThinkingStep = ({ setup, change, name, models }: StepProps) => {
  const { t } = useLingui();
  const { effortNames } = useSetupWords();
  const effortLines: Record<Effort, string> = {
    low: t`Fastest. For simple, routine jobs.`,
    medium: t`Quick and careful. Good for most jobs.`,
    high: t`Thinks longer. For tricky questions.`,
    extra: t`Thinks much longer. For hard problems.`,
    max: t`Its very best work, and the slowest.`,
  };
  const chosen = setup.model ?? askersOwn;
  return (
    <Question title={t`How hard should ${name} think?`}>
      <div {...stylex.props(styles.panel)}>
        <section {...stylex.props(styles.part)}>
          <Heading level={2} size="ui-sm">
            {t`Model`}
          </Heading>
          <RadioGroup
            aria-label={t`Model`}
            onValueChange={(value) => {
              change({
                model: value === null || value === askersOwn ? null : value,
              });
            }}
            value={chosen}
          >
            <div {...stylex.props(styles.cards)}>
              <ModelCard
                brand={undefined}
                chosen={chosen === askersOwn}
                label={t`Picked in the chat`}
                line={t`Uses the model the person chose.`}
                value={askersOwn}
              />
              {models.map((model) => (
                <ModelCard
                  brand={makerMarks[makerOf(model)]}
                  chosen={chosen === model}
                  key={model}
                  label={modelName(model)}
                  line={t`Always uses this model.`}
                  value={model}
                />
              ))}
            </div>
          </RadioGroup>
        </section>
        <Card>
          <div {...stylex.props(styles.effort)}>
            <LevelSlider
              label={t`Effort`}
              levels={efforts.map((effort) => ({
                id: effort,
                label: effortNames[effort],
              }))}
              onValueChange={(value) => {
                const effort = efforts.find((each) => each === value);
                if (effort !== undefined) {
                  change({ effort });
                }
              }}
              value={setup.effort}
            />
            <span {...stylex.props(styles.inside)}>
              <Badge>{effortNames[setup.effort]}</Badge>
              <Text tone="muted">{effortLines[setup.effort]}</Text>
            </span>
          </div>
        </Card>
      </div>
    </Question>
  );
};
