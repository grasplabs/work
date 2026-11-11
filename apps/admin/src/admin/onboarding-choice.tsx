/**
 * The onboarding a new organization starts with, as staff choose it on
 * the create page: one of the flows staff start from
 * (@grasp-os/shared/onboarding-flow), all of it unless they choose
 * another. It is in place before anyone at the company signs in; what
 * the company goes through after that is changed on its Flow page.
 */
import { flowPresetNames } from "@grasp-os/shared/onboarding-flow";
import type { FlowPreset } from "@grasp-os/shared/onboarding-flow";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@grasp-os/ui/components/field";
import {
  RadioGroup,
  RadioGroupItem,
} from "@grasp-os/ui/components/radio-group";
import { useId } from "react";

/** Each flow staff start from, as staff read it, and what the company goes through in it. */
const presetWords: Record<FlowPreset, { name: string; about: string }> = {
  full: {
    name: "Full",
    about: "Every step, the interviews, and Grasp’s own steps before them.",
  },
  short: {
    name: "Short",
    about: "Who’s who, the team leads and the interviews.",
  },
  setup: {
    name: "Setup only",
    about:
      "Its admin sets Grasp up; nobody is interviewed. It opens when they finish.",
  },
  none: {
    name: "No onboarding",
    about: "Everyone signs in straight to the platform.",
  },
};

/** The choice itself, controlled by `value`. */
export const OnboardingChoice = ({
  value,
  onChange,
}: {
  value: FlowPreset;
  onChange: (value: FlowPreset) => void;
}) => {
  const id = useId();
  return (
    <FieldSet>
      <FieldLegend variant="label">Onboarding</FieldLegend>
      <RadioGroup
        name="onboarding"
        onValueChange={(next) => {
          const preset = flowPresetNames.find((name) => name === next);
          if (preset !== undefined) {
            onChange(preset);
          }
        }}
        value={value}
      >
        {flowPresetNames.map((preset) => (
          <Field key={preset} orientation="horizontal">
            <RadioGroupItem id={`${id}-${preset}`} value={preset} />
            <FieldContent>
              <FieldLabel htmlFor={`${id}-${preset}`}>
                {presetWords[preset].name}
              </FieldLabel>
              <FieldDescription>{presetWords[preset].about}</FieldDescription>
            </FieldContent>
          </Field>
        ))}
      </RadioGroup>
      <FieldDescription>
        In place before anyone signs in. Change it later on its Flow page.
      </FieldDescription>
    </FieldSet>
  );
};
