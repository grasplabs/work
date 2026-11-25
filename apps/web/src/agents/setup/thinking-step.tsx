import { BrandIcon } from "@grasp-os/ui/components/brand-icon";
import { FieldGroup } from "@grasp-os/ui/components/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { Icon, SparklesIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { modelName } from "../../chat/composer.tsx";
import { makerMark } from "../../frame/brands.ts";
import { SectionCard } from "../section-card.tsx";
import { SettingRow } from "../setting-row.tsx";
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

/** Who makes `model`: the first part of its id. */
const makerOf = (model: string): string => model.split("/")[0] ?? "";

const styles = stylex.create({
  control: { width: "16rem", maxWidth: "100%" },
  model: { display: "inline-flex", alignItems: "center", gap: space["2"] },
});

/**
 * A model's mark: its maker's (the product's marks, as the chat's box has
 * them: a maker it has none for by its first letter), or the sparkles for
 * the one picked in the chat.
 */
const Mark = ({ maker }: { maker: string | undefined }) => {
  if (maker === undefined) {
    return <Icon icon={SparklesIcon} />;
  }
  const logo = makerMark(maker);
  return (
    <BrandIcon
      decorative
      name={maker}
      size="xs"
      {...(logo === undefined ? {} : { logo })}
    />
  );
};

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
    { value: askersOwn, label: t`Picked in the chat`, maker: undefined },
    ...models.map((model) => ({
      value: model,
      label: modelName(model),
      maker: makerOf(model),
    })),
  ];
  const shown = options.find(({ value }) => value === chosen);
  return (
    <Question title={t`How hard should ${name} think?`}>
      <SectionCard aria-label={t`Thinking`} flush>
        <FieldGroup>
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
                <SelectTrigger {...field} style={styles.control} size="sm">
                  {shown === undefined ? null : <Mark maker={shown.maker} />}
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
                        <Mark maker={option.maker} />
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
                <ToggleGroupItem key={effort} value={effort}>
                  {effortNames[effort]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </SettingRow>
        </FieldGroup>
      </SectionCard>
    </Question>
  );
};
