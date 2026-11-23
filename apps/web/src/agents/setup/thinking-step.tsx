import { FieldGroup } from "@grasp-os/ui/components/field";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { modelName } from "../../chat/composer.tsx";
import { SettingRow, SettingsCard } from "../settings-card.tsx";
import { efforts } from "./model.ts";
import type { Effort, StepProps } from "./model.ts";
import { Question } from "./question.tsx";
import { useSetupWords } from "./words.ts";

// How hard it thinks, on Settings' own parts (Ruben, 21 November: "pick
// the UI components from settings", the slider was bad): one card with a
// row each, as AI providers has its models. The model in a picker, the one
// the person picks in the chat first; the effort as one row of segments,
// the chosen level's meaning under its name.

/** The value of "the one the person picks in the chat" among the choices. */
const askersOwn = "asker";

const styles = stylex.create({
  control: { display: "block", width: "16rem", maxWidth: "100%" },
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
  const options = [
    { value: askersOwn, label: t`Picked in the chat` },
    ...models.map((model) => ({ value: model, label: modelName(model) })),
  ];
  return (
    <Question title={t`How hard should ${name} think?`}>
      <SettingsCard aria-label={t`Thinking`}>
        <FieldGroup>
          <SettingRow
            help={
              chosen === askersOwn
                ? t`Follows the chat's choice`
                : t`Always uses this model`
            }
            label={t`Model`}
          >
            <span {...stylex.props(styles.control)}>
              <Select
                items={options}
                onValueChange={(value) => {
                  change({
                    model: value === null || value === askersOwn ? null : value,
                  });
                }}
                value={chosen}
              >
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent />
              </Select>
            </span>
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
      </SettingsCard>
    </Question>
  );
};
