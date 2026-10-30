import { fewestPeople } from "@grasp-os/shared/stephen-requests";
import type { RequestsPage } from "@grasp-os/shared/stephen-requests";
import { Button } from "@grasp-os/ui/components/button";
import {
  ButtonGroup,
  ButtonGroupText,
} from "@grasp-os/ui/components/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { useLingui } from "@lingui/react/macro";
import { ChevronDownIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { PlaceLogo, placeName } from "./request-parts.tsx";

// What the requests are narrowed to, as the prototype's
// `request-filters.tsx`: one filter for the place and one for the team,
// each "Place is All" until it is narrowed. A team fewer than five can
// reach isn't offered: core would show nothing for it.

/** What filters nothing. */
const all = "all";

interface Option {
  value: string;
  label: string;
  mark?: ReactNode;
}

/** One filter: what is filtered, a menu of what it can be narrowed to, and a way back to all of it. */
const FilterChip = ({
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
}) => {
  const { t } = useLingui();
  const chosen = options.find((option) => option.value === value);
  return (
    <ButtonGroup>
      <ButtonGroupText>
        {t({ message: `${label} is`, context: 'filter: "Place is All"' })}
      </ButtonGroupText>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
          {chosen?.mark}
          {chosen?.label ??
            t({ message: "All", context: "filter: nothing narrowed" })}
          <ChevronDownIcon data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuRadioGroup
            onValueChange={(next: string) => {
              onChange(next === all ? null : next);
            }}
            value={value ?? all}
          >
            <DropdownMenuRadioItem closeOnClick value={all}>
              {allLabel}
            </DropdownMenuRadioItem>
            {options.map((option) => (
              <DropdownMenuRadioItem
                closeOnClick
                key={option.value}
                value={option.value}
              >
                {option.mark}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {chosen === undefined ? null : (
        <Button
          aria-label={allLabel}
          onClick={() => {
            onChange(null);
          }}
          size="icon-sm"
          variant="outline"
        >
          <XIcon />
        </Button>
      )}
    </ButtonGroup>
  );
};

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
    <div className="flex flex-wrap gap-2">
      <FilterChip
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
      <FilterChip
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
