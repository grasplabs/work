import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { modelName } from "../../chat/model-names.tsx";
import { BrandIcon } from "../../grasp/brand-icon/index.ts";
import type { Brand } from "../../grasp/brand-icon/index.ts";
import { Icon, Sparkles } from "../../grasp/icons/index.ts";
import { SectionCard } from "../../grasp/section-card/index.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../grasp/select/index.ts";
import { SettingRow, SettingsRows } from "../../grasp/setting-row/index.ts";
import { Toggle, ToggleGroup } from "../../grasp/toggle/index.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import { efforts } from "./model.ts";
import type { Effort, StepProps } from "./model.ts";
import { Question } from "./question.tsx";
import { useSetupWords } from "./words.ts";

// How hard it thinks, on Settings' own parts (Ruben, 21 November: "pick
// the UI components from settings", the slider was bad): one grouped card
// with a row each, as AI providers has its models. The model in a picker
// that shows each maker's mark, the one the person picks in the chat
// first; the effort as one row of segments, the chosen level's meaning
// under its name.

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
  control: { width: "16rem", maxWidth: "100%" },
  model: { display: "inline-flex", alignItems: "center", gap: grasp.space2 },
});

/** A model's mark: its maker's, or the sparkles for the one picked in the chat. */
const Mark = ({ brand }: { brand: Brand | undefined }) =>
  brand === undefined ? (
    <Icon icon={Sparkles} />
  ) : (
    <BrandIcon brand={brand} decorative size="xs" />
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
  const options = [
    { value: askersOwn, label: t`Picked in the chat`, brand: undefined },
    ...models.map((model) => ({
      value: model,
      label: modelName(model),
      brand: makerMarks[makerOf(model)],
    })),
  ];
  const shown = options.find(({ value }) => value === chosen);
  return (
    <Question title={t`How hard should ${name} think?`}>
      <SectionCard
        aria-label={t`Thinking`}
        density="compact"
        flush
        variant="grouped"
      >
        <SettingsRows>
          <SettingRow
            help={
              chosen === askersOwn
                ? t`Follows the chat's choice`
                : t`Always uses this model`
            }
            label={t`Model`}
          >
            {(field) => (
              <Select
                onValueChange={(value) => {
                  change({
                    model: value === null || value === askersOwn ? null : value,
                  });
                }}
                value={chosen}
              >
                <SelectTrigger {...field} layout={styles.control} size="sm">
                  {shown === undefined ? null : <Mark brand={shown.brand} />}
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((option) => (
                    <SelectItem
                      key={option.value}
                      label={option.label}
                      value={option.value}
                    >
                      <span {...stylex.props(styles.model)}>
                        <Mark brand={option.brand} />
                        {option.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </SettingRow>
          <SettingRow help={effortLines[setup.effort]} label={t`Effort`}>
            <ToggleGroup
              aria-label={t`Effort`}
              onValueChange={(values) => {
                const effort = efforts.find((each) => each === values[0]);
                if (effort !== undefined) {
                  change({ effort });
                }
              }}
              size="sm"
              value={[setup.effort]}
            >
              {efforts.map((effort) => (
                <Toggle key={effort} value={effort}>
                  {effortNames[effort]}
                </Toggle>
              ))}
            </ToggleGroup>
          </SettingRow>
        </SettingsRows>
      </SectionCard>
    </Question>
  );
};
