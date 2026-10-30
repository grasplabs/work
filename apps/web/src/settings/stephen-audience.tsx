import type { ToolClassAudience } from "@grasp-os/shared/connect";
import type {
  AppClassAudience,
  PlaceAudience,
  StephenReach,
} from "@grasp-os/shared/stephen-reach";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";

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
  const id = useId();
  const [who, setWho] = useState<Who>(value.who);
  const save = async (chosen: Chosen): Promise<void> => {
    await onSave(
      chosen.who === "teams" && chosen.teams.length === 0
        ? { who: "nobody", teams: [] }
        : chosen
    );
  };
  return (
    <div className="flex flex-col gap-2 sm:items-end">
      <NativeSelect
        aria-label={label}
        disabled={!editable}
        id={id}
        size="sm"
        value={who}
        onChange={(event) => {
          const next = offers.find((one) => one === event.target.value);
          if (next === undefined) {
            return;
          }
          setWho(next);
          if (next !== "teams") {
            void save({ who: next, teams: [] });
          }
        }}
      >
        {offers.map((one) => (
          <NativeSelectOption key={one} value={one}>
            {one === "same" ? same : i18n._(whoLabels[one])}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {who === "teams" ? (
        <ul aria-label={t`Teams for ${label}`} className="flex flex-col gap-1">
          {teams.map(({ teamId, name }) => (
            <li key={teamId}>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={value.teams.includes(teamId)}
                  disabled={!editable}
                  onCheckedChange={(checked) => {
                    const rest = value.teams.filter((one) => one !== teamId);
                    void save({
                      who: "teams",
                      teams: checked ? [...rest, teamId] : rest,
                    });
                  }}
                />
                {name}
              </label>
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
