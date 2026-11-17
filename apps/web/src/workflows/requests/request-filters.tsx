import { fewestPeople } from "@grasp-os/shared/stephen-requests";
import type { RequestsPage } from "@grasp-os/shared/stephen-requests";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../grasp/select/index.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import { PlaceLogo, placeName } from "./request-parts.tsx";

// What the requests are narrowed to, as the prototype's
// `request-filters.tsx`: one filter for the place and one for the team,
// each "All places" until it is narrowed, and back to all by choosing it
// again. A team fewer than five can reach isn't offered: core would show
// nothing for it.

/** What filters nothing. */
const all = "all";

interface Option {
  value: string;
  label: string;
  mark?: ReactNode;
}

const styles = stylex.create({
  filters: { display: "flex", flexWrap: "wrap", gap: grasp.space2 },
  // A filter as wide as its longest choice, at least as wide as "All places".
  filter: { minWidth: "10rem" },
  option: { display: "flex", alignItems: "center", gap: grasp.space2 },
});

/** One filter: a list of what it can be narrowed to, all of it first. */
const Filter = ({
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  allLabel: string;
  value: string | null;
  options: Option[];
  onChange: (value: string | null) => void;
}) => (
  <Select
    items={[
      { value: all, label: allLabel },
      ...options.map((option) => ({
        value: option.value,
        label: option.label,
      })),
    ]}
    onValueChange={(next) => {
      onChange(next === null || next === all ? null : next);
    }}
    value={value ?? all}
  >
    <SelectTrigger aria-label={label} layout={styles.filter} size="sm">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value={all}>{allLabel}</SelectItem>
      {options.map((option) => (
        <SelectItem
          key={option.value}
          label={option.label}
          value={option.value}
        >
          <span {...stylex.props(styles.option)}>
            {option.mark}
            {option.label}
          </span>
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

/** The place and team filters. */
export const RequestFilters = ({
  page,
  place,
  team,
  onPlace,
  onTeam,
}: {
  page: Pick<RequestsPage, "places" | "teams">;
  place: string | null;
  team: string | null;
  onPlace: (place: string | null) => void;
  onTeam: (team: string | null) => void;
}) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.filters)}>
      <Filter
        allLabel={t`All places`}
        label={t({
          message: "Place",
          context: "filter: where people reach Stephen",
        })}
        onChange={onPlace}
        options={page.places.map((each) => ({
          value: each,
          label: placeName(each),
          mark: <PlaceLogo place={each} />,
        }))}
        value={place}
      />
      <Filter
        allLabel={t`All teams`}
        label={t({ message: "Team", context: "filter: which team asked" })}
        onChange={onTeam}
        options={page.teams
          .filter(({ reach }) => reach >= fewestPeople)
          .map(({ id, name }) => ({ value: id, label: name }))}
        value={team}
      />
    </div>
  );
};
