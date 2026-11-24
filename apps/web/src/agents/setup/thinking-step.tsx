import { FieldGroup } from "@grasp-os/ui/components/field";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { modelName } from "../../chat/composer.tsx";
import { SettingRow, SettingsCard } from "../settings-card.tsx";
import type { StepProps } from "./model.ts";
import { Question } from "./question.tsx";

// Which model its turns use, on Settings' own parts (Ruben, 21 November:
// "pick the UI components from settings"): one card with one row, as AI
// providers has its models, the one the person picks in the chat first.
// How hard it thinks is asked once core keeps it for an agent.

/** The value of "the one the person picks in the chat" among the choices. */
const askersOwn = "asker";

const styles = stylex.create({
  control: { width: "16rem", maxWidth: "100%" },
});

export const ThinkingStep = ({ setup, change, name, models }: StepProps) => {
  const { t } = useLingui();
  const chosen = setup.model ?? askersOwn;
  const options = [
    { value: askersOwn, label: t`Picked in the chat` },
    ...models.map((model) => ({ value: model, label: modelName(model) })),
  ];
  return (
    <Question title={t`Which model should ${name} use?`}>
      <SettingsCard aria-label={t`Model`}>
        <FieldGroup>
          <SettingRow
            help={
              chosen === askersOwn
                ? t`Follows the chat's choice`
                : t`Always uses this model`
            }
            label={t`Model`}
          >
            <Select
              items={options}
              onValueChange={(value) => {
                change({
                  model: value === null || value === askersOwn ? null : value,
                });
              }}
              value={chosen}
            >
              <SelectTrigger size="sm" style={styles.control}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent />
            </Select>
          </SettingRow>
        </FieldGroup>
      </SettingsCard>
    </Question>
  );
};
