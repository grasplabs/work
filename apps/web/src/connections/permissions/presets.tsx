// Concept A, one choice: what Grasp may do in the app, as four answers from
// the safest down: view only (where it starts), view and create, everything,
// or choosing per action. A chosen answer says what falls under it; only
// "Choose myself" opens the list, grouped by kind, each group with one box
// for all of it. The admin decides once and reads one line.
import { Badge } from "@grasp-os/ui/components/badge";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
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
import {
  boxOf,
  choiceOf,
  countOn,
  isPreset,
  ofKind,
  presetChoice,
  presetOf,
  toolKinds,
  withAll,
  ticked,
  withChoice,
} from "./model.ts";
import type { Preset, SortedTool, ToolKind } from "./model.ts";
import { KindMark, useKindWords } from "./parts.tsx";

const styles = stylex.create({
  stack: { display: "grid", gap: space[4] },
  choices: { display: "grid", gap: space[2] },
  card: {
    display: "grid",
    gap: space[2],
    paddingInline: space[4],
    paddingBlock: space[1],
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.lg,
    transitionProperty: "border-color, background-color",
    transitionDuration: "150ms",
    marginBlockEnd: space[2],
  },
  chosen: { borderColor: colors.foreground, backgroundColor: colors.card },
  head: { display: "flex", alignItems: "center", gap: space[2] },
  count: { marginInlineStart: "auto", whiteSpace: "nowrap" },
  group: {
    display: "grid",
    gap: space[2],
    paddingBlock: space[3],
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  groupHead: {
    display: "grid",
    gridTemplateColumns: "auto auto minmax(0, 1fr)",
    alignItems: "center",
    gap: space[3],
  },
  rows: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(14rem, 1fr))",
    columnGap: space[4],
    rowGap: space[1],
    margin: 0,
    paddingInlineStart: space[8],
    listStyle: "none",
  },
  row: { display: "flex", alignItems: "center", gap: space[2], minWidth: 0 },
});

/** One kind's tools, each a box, under one box for all of them. */
const KindGroup = ({
  kind,
  tools,
  allowed,
  onAllowed,
}: {
  kind: ToolKind;
  tools: readonly SortedTool[];
  allowed: readonly AllowedTool[];
  onAllowed: (next: AllowedTool[]) => void;
}) => {
  const { t } = useLingui();
  const words = useKindWords()[kind];
  const on = countOn(allowed, tools);
  const [open, setOpen] = useState(on > 0 && on < tools.length);
  if (tools.length === 0) {
    return null;
  }
  return (
    <div {...stylex.props(styles.group)}>
      <div {...stylex.props(styles.groupHead)}>
        <Checkbox
          aria-label={t`All of ${words.title}`}
          checked={boxOf(on, tools.length)}
          onCheckedChange={(checked) => {
            onAllowed(withAll(allowed, tools, checked === true));
          }}
        />
        <KindMark kind={kind} />
        <Collapsible onOpenChange={setOpen} open={open} variant="plain">
          <CollapsibleTrigger size="sm">
            {t`${words.title} · ${on} of ${tools.length}`}
          </CollapsibleTrigger>
          <CollapsibleContent asChild>
            <ul {...stylex.props(styles.rows)}>
              {tools.map(({ tool, name, deprecated }) => (
                <li key={tool.name} {...stylex.props(styles.row)}>
                  <Checkbox
                    aria-label={name}
                    checked={choiceOf(allowed, tool.name) !== "off"}
                    onCheckedChange={(checked) => {
                      onAllowed(
                        withChoice(
                          allowed,
                          tool.name,
                          ticked(tool, checked === true)
                        )
                      );
                    }}
                  />
                  <Text as="span" color="secondary" size="sm" truncate>
                    {deprecated ? t`${name} (old)` : name}
                  </Text>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      </div>
      <Text color="muted" size="xs">
        {words.note}
      </Text>
    </div>
  );
};

/** Concept A: what Grasp may do, in one choice. */
export const Presets = ({
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
  const countOf = (chosen: Exclude<Preset, "own">): number =>
    presetChoice(sorted, chosen).length;
  const answers: {
    value: Preset;
    label: string;
    description: string;
    recommended?: boolean;
  }[] = [
    {
      value: "look",
      label: t`View only`,
      description: t`Grasp reads what is in ${app} and changes nothing.`,
      recommended: true,
    },
    {
      value: "change",
      label: t`View, create and change`,
      description: t`Also creates and changes things. Grasp asks first.`,
    },
    {
      value: "all",
      label: t`Everything, deleting too`,
      description: t`Also deletes and cancels. Grasp asks first.`,
    },
    {
      value: "own",
      label: t`Choose myself`,
      description: t`Turn each action on or off.`,
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
    <div {...stylex.props(styles.stack)}>
      <RadioGroup
        aria-label={t`What Grasp may do`}
        onValueChange={(value) => {
          if (isPreset(value)) {
            choose(value);
          }
        }}
        value={preset}
      >
        {answers.map(({ value, label, description, recommended }) => (
          <div
            key={value}
            {...stylex.props(styles.card, preset === value && styles.chosen)}
          >
            <Field orientation="horizontal">
              <RadioGroupItem
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
                          {t`${countOf(value)} actions`}
                        </Text>
                      </span>
                    )}
                  </span>
                </FieldLabel>
                <FieldDescription>{description}</FieldDescription>
              </FieldContent>
            </Field>
            {preset === "own" && value === "own"
              ? toolKinds.map((kind) => (
                  <KindGroup
                    allowed={allowed}
                    key={kind}
                    kind={kind}
                    onAllowed={onAllowed}
                    tools={ofKind(sorted, kind)}
                  />
                ))
              : null}
          </div>
        ))}
      </RadioGroup>
    </div>
  );
};
