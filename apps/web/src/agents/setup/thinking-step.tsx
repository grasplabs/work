import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { modelName } from "../../chat/model-names.tsx";
import { BrandIcon } from "../../grasp/brand-icon/index.ts";
import type { Brand } from "../../grasp/brand-icon/index.ts";
import { Heading } from "../../grasp/heading/index.ts";
import { IconTile } from "../../grasp/icon-tile/index.ts";
import { Sparkles } from "../../grasp/icons/index.ts";
import { LevelSlider } from "../../grasp/level-slider/index.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import { ChoiceCards } from "./choice-cards.tsx";
import { efforts } from "./model.ts";
import type { Effort, StepProps } from "./model.ts";
import { Question } from "./question.tsx";
import { useSetupWords } from "./words.ts";

// How hard it thinks, in one go (Ruben, 21 November: the cards and the
// panel round the slider were too much): which model it uses, as cards
// to press with each maker's mark (or the one the person picks in the
// chat), and how much effort, on the library's Level slider, which says
// under it what the chosen level means. No badge repeating the level.

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
  panel: { display: "grid", gap: grasp.space8 },
  part: { display: "grid", gap: grasp.space3 },
});

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
          <ChoiceCards
            cards={[
              {
                value: askersOwn,
                title: t`Picked in the chat`,
                description: t`Uses the model the person chose.`,
                media: <IconTile icon={Sparkles} size="sm" variant="tint" />,
              },
              ...models.map((model) => {
                const brand = makerMarks[makerOf(model)];
                return {
                  value: model,
                  title: modelName(model),
                  description: t`Always uses this model.`,
                  media:
                    brand === undefined ? (
                      <IconTile icon={Sparkles} size="sm" variant="tint" />
                    ) : (
                      <BrandIcon brand={brand} decorative tile />
                    ),
                };
              }),
            ]}
            columns={2}
            label={t`Model`}
            layout="row"
            onValueChange={(value) => {
              change({ model: value === askersOwn ? null : value });
            }}
            value={chosen}
          />
        </section>
        <LevelSlider
          label={t`Effort`}
          levels={efforts.map((effort) => ({
            id: effort,
            label: effortNames[effort],
            description: effortLines[effort],
          }))}
          onValueChange={(value) => {
            const effort = efforts.find((each) => each === value);
            if (effort !== undefined) {
              change({ effort });
            }
          }}
          value={setup.effort}
        />
      </div>
    </Question>
  );
};
