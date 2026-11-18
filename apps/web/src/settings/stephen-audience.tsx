import type { ToolClassAudience } from "@grasp-os/shared/connect";
import type {
  AppClassAudience,
  PlaceAudience,
  StephenReach,
} from "@grasp-os/shared/stephen-reach";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { Checkbox } from "../grasp/checkbox/index.ts";
import { Field, FieldContent, FieldLabel } from "../grasp/field/index.ts";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// Who a setting of Settings › Stephen reaches (stephen-settings.tsx,
// stephen-card.tsx): as the layer above, everyone, some teams, or nobody.
// A layer only ever narrows the one above it; core holds it to that.

/** Who a control may choose: as the layer above, everyone, some teams, or nobody. */
export type Who = "same" | "everyone" | "teams" | "nobody";

/** An audience of any layer, as a control holds it. */
export interface Chosen {
  who: Who;
  teams: string[];
}

export const chosenOf = (
  audience: ToolClassAudience | PlaceAudience | AppClassAudience
): Chosen => {
  if (audience.who === "teams") {
    return { who: "teams", teams: audience.teams };
  }
  if (audience.who === "asStephen" || audience.who === "asClass") {
    return { who: "same", teams: [] };
  }
  return { who: audience.who, teams: [] };
};

const styles = stylex.create({
  // The choice, then its teams under it, both on the row's control edge.
  control: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    minWidth: 0,
    width: "100%",
  },
  fill: { width: "100%" },
  teams: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
});

const whoLabels = {
  everyone: msg`Everyone`,
  teams: msg`Chosen teams`,
  nobody: msg`Nobody yet`,
} as const satisfies Record<Exclude<Who, "same">, MessageDescriptor>;

/**
 * Who a setting reaches: a choice, then the teams when it is some teams.
 * It saves once it is whole: a choice of teams waits for its first team,
 * and taking the last one away leaves nobody.
 */
export const AudienceControl = ({
  label,
  value,
  offers,
  same,
  teams,
  editable,
  onSave,
}: {
  label: string;
  value: Chosen;
  offers: readonly Who[];
  /** What "as the layer above" is called here, when it is offered. */
  same?: string;
  teams: StephenReach["teams"];
  editable: boolean;
  onSave: (chosen: Chosen) => Promise<void>;
}) => {
  const { t, i18n } = useLingui();
  const [who, setWho] = useState<Who>(value.who);
  const save = async (chosen: Chosen): Promise<void> => {
    await onSave(
      chosen.who === "teams" && chosen.teams.length === 0
        ? { who: "nobody", teams: [] }
        : chosen
    );
  };
  const items = offers.map((one) => ({
    value: one,
    label: one === "same" ? (same ?? "") : i18n._(whoLabels[one]),
  }));
  return (
    <div {...stylex.props(styles.control)}>
      <Select
        disabled={!editable}
        items={items}
        onValueChange={(chosen) => {
          const next = offers.find((one) => one === chosen);
          if (next === undefined) {
            return;
          }
          setWho(next);
          if (next !== "teams") {
            void save({ who: next, teams: [] });
          }
        }}
        value={who}
      >
        <SelectTrigger aria-label={label} layout={styles.fill} size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent />
      </Select>
      {who === "teams" ? (
        <ul aria-label={t`Teams for ${label}`} {...stylex.props(styles.teams)}>
          {teams.map(({ teamId, name }) => (
            <li key={teamId}>
              <Field orientation="horizontal">
                <Checkbox
                  checked={value.teams.includes(teamId)}
                  disabled={!editable}
                  onCheckedChange={(checked) => {
                    const rest = value.teams.filter((one) => one !== teamId);
                    void save({
                      who: "teams",
                      teams: checked === true ? [...rest, teamId] : rest,
                    });
                  }}
                />
                <FieldContent>
                  <FieldLabel>{name}</FieldLabel>
                </FieldContent>
              </Field>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};

/** A company-wide audience as core takes it. */
export const audienceOf = ({ who, teams }: Chosen): ToolClassAudience => {
  if (who === "teams") {
    return { who, teams };
  }
  return { who: who === "everyone" ? "everyone" : "nobody" };
};

/** A place's audience as core takes it. */
export const placeAudienceOf = (chosen: Chosen): PlaceAudience =>
  chosen.who === "same" ? { who: "asStephen" } : audienceOf(chosen);

/** An app's audience for a class as core takes it. */
export const appAudienceOf = (chosen: Chosen): AppClassAudience =>
  chosen.who === "same" ? { who: "asClass" } : audienceOf(chosen);
