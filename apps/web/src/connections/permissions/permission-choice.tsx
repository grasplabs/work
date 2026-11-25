// What Grasp may do in an app, in one choice: four answers from the safest
// down, in one hairline list: view only (where it starts), view and change,
// everything, or choosing per action. "Choose myself" opens the list of
// actions under it, each with Off, Read or Write, found by typing.
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import {
  RadioGroup,
  RadioGroupItem,
} from "@grasp-os/ui/components/radio-group";
import { Text } from "@grasp-os/ui/components/text";
import { colors, radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import type { AllowedTool } from "../tool-choices.ts";
import { ActionList } from "./action-list.tsx";
import { isPreset, presetChoice, presetOf } from "./model.ts";
import type { Preset, SortedTool } from "./model.ts";

const styles = stylex.create({
  list: {
    display: "grid",
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.lg,
  },
  answer: {
    display: "grid",
    gap: space[3],
    paddingInline: space[3],
    paddingBlock: space[2],
    transitionProperty: "background-color",
    transitionDuration: "150ms",
  },
  between: {
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  chosen: { backgroundColor: colors.card },
  head: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space[2],
    rowGap: space[1],
  },
  count: { marginInlineStart: "auto", whiteSpace: "nowrap" },
});

/** What Grasp may do: a preset, or each action chosen by hand. */
export const PermissionChoice = ({
  app,
  sorted,
  allowed,
  onAllowed,
}: {
  app: string;
  sorted: readonly SortedTool[];
  allowed: readonly AllowedTool[];
  onAllowed: (next: AllowedTool[]) => void;
}) => {
  const { t } = useLingui();
  const found = presetOf(sorted, allowed);
  // Choosing per action stays chosen while it happens to match a preset.
  const [own, setOwn] = useState(false);
  const preset: Preset = own ? "own" : found;
  const answers: {
    value: Preset;
    label: string;
    description: string;
    recommended?: boolean;
  }[] = [
    {
      value: "look",
      label: t`View only`,
      description: t`Reads what is in ${app}, changes nothing.`,
      recommended: true,
    },
    {
      value: "change",
      label: t`View and change`,
      description: t`Also creates and edits. Grasp asks first.`,
    },
    {
      value: "all",
      label: t`Everything`,
      description: t`Also deletes and cancels. Grasp asks first.`,
    },
    {
      value: "own",
      label: t`Choose myself`,
      description: t`Set each action to Off, Read or Write.`,
    },
  ];
  const choose = (value: Preset): void => {
    if (value === "own") {
      setOwn(true);
      return;
    }
    setOwn(false);
    onAllowed(presetChoice(sorted, value));
  };
  return (
    <RadioGroup
      aria-label={t`What Grasp may do`}
      onValueChange={(value) => {
        if (isPreset(value)) {
          choose(value);
        }
      }}
      value={preset}
    >
      <div {...stylex.props(styles.list)}>
        {answers.map(({ value, label, description, recommended }, index) => (
          <div
            key={value}
            {...stylex.props(
              styles.answer,
              index > 0 && styles.between,
              preset === value && styles.chosen
            )}
          >
            <Field orientation="horizontal">
              <RadioGroupItem
                // A press on the answer already chosen keeps it.
                onClick={() => {
                  choose(value);
                }}
                value={value}
              />
              <FieldContent>
                <FieldLabel>
                  <span {...stylex.props(styles.head)}>
                    {label}
                    {recommended === true ? (
                      <Badge size="sm" variant="success">
                        {t`Recommended`}
                      </Badge>
                    ) : null}
                    {value === "own" ? null : (
                      <span {...stylex.props(styles.count)}>
                        <Text as="span" color="subtle" size="xs">
                          {t`${presetChoice(sorted, value).length} actions`}
                        </Text>
                      </span>
                    )}
                  </span>
                </FieldLabel>
                <FieldDescription>{description}</FieldDescription>
              </FieldContent>
            </Field>
            {value === "own" && preset === "own" ? (
              <ActionList
                allowed={allowed}
                onAllowed={onAllowed}
                sorted={sorted}
              />
            ) : null}
          </div>
        ))}
      </div>
    </RadioGroup>
  );
};
