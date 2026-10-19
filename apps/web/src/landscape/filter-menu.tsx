import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  DatabaseIcon,
  LayoutGridIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  UserIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { AppLogo } from "../connections/app-logo.tsx";
import { StatusDot } from "./insight.tsx";
import type { Tone } from "./insight.tsx";
import {
  activeFilterCount,
  aiTypeLabel,
  aiTypes,
  dataExposureTypes,
  exposureMeta,
  noFilters,
  quickFilterLabel,
  quickFilters,
  usersBucketLabel,
  usersBuckets,
} from "./landscape.ts";
import type {
  LandscapeApp,
  LandscapeFilters,
  QuickFilter,
} from "./landscape.ts";
import { hoverDelay, ToolbarLabel } from "./toolbar.tsx";

// The Landscape's filter, as the prototype's toolbar has it
// (`components/landscape/filter-menu.tsx`): a search on top, one submenu
// per kind of filter that opens on hover and shows its current choice, and
// the quick filters underneath.

const quickFilterTone: Record<QuickFilter, Tone> = {
  unowned: "attention",
  unused: "neutral",
  core: "neutral",
};

type FilterKey = Exclude<keyof LandscapeFilters, "show">;

interface Option {
  value: string;
  label: string;
  media?: ReactNode;
}

interface Dimension {
  key: FilterKey;
  label: string;
  /** The choice that filters nothing. */
  any: string;
  /** The placeholder of the search in its submenu, when it has one. */
  search?: string;
  icon: LucideIcon;
  options: Option[];
}

/** Typing stays in the search field instead of jumping through the menu items; Escape and ↓ still reach the menu. */
const keepKeys = (event: KeyboardEvent) => {
  if (event.key !== "Escape" && event.key !== "ArrowDown") {
    event.stopPropagation();
  }
};

/** A search line at the top of a menu. */
const MenuSearch = ({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) => (
  <label className="text-muted-foreground flex items-center gap-2 px-2 py-1.5">
    <SearchIcon aria-hidden="true" className="size-4 shrink-0" />
    <input
      aria-label={placeholder}
      className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
      onChange={(event) => {
        onChange(event.target.value);
      }}
      onKeyDown={keepKeys}
      placeholder={placeholder}
      value={value}
    />
  </label>
);

/** One kind of filter: its current choice in the row, the choices in a submenu that opens on hover. */
const DimensionMenu = ({
  dimension,
  current,
  value,
  onValueChange,
}: {
  dimension: Dimension;
  current: string | undefined;
  value: string;
  onValueChange: (value: string) => void;
}) => {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLocaleLowerCase();
  const options = dimension.options.filter(
    (option) =>
      needle === "" || option.label.toLocaleLowerCase().includes(needle)
  );
  const Icon = dimension.icon;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Icon />
        <span className="flex-1">{dimension.label}</span>
        {current === undefined ? null : (
          <span className="text-muted-foreground max-w-28 truncate">
            {current}
          </span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-60">
        {dimension.search === undefined ? null : (
          <>
            <MenuSearch
              onChange={setSearch}
              placeholder={dimension.search}
              value={search}
            />
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuRadioGroup
          onValueChange={(next: string) => {
            onValueChange(next);
          }}
          value={value}
        >
          <DropdownMenuRadioItem value="all">
            <Icon />
            {dimension.any}
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          <div className="max-h-64 overflow-y-auto">
            {options.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.media ?? <Icon />}
                <span className="truncate">{option.label}</span>
              </DropdownMenuRadioItem>
            ))}
            {options.length === 0 ? (
              <p className="text-muted-foreground px-2 py-1.5">
                <Trans>Nothing found.</Trans>
              </p>
            ) : null}
          </div>
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
};

/** The filter in the Landscape's toolbar. */
export const FilterMenu = ({
  filters,
  onChange,
  apps,
  open,
  onOpenChange,
}: {
  filters: LandscapeFilters;
  onChange: (filters: LandscapeFilters) => void;
  apps: readonly LandscapeApp[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t, i18n } = useLingui();
  const [search, setSearch] = useState("");
  const active = activeFilterCount(filters);
  const owners = [
    ...new Set(apps.flatMap((app) => (app.owner === null ? [] : [app.owner]))),
  ].toSorted();

  const dimensions: Dimension[] = [
    {
      key: "aiType",
      label: t`AI type`,
      any: t`Any AI type`,
      icon: SparklesIcon,
      options: aiTypes.map((value) => ({
        value,
        label: i18n._(aiTypeLabel[value]),
      })),
    },
    {
      key: "dataExposure",
      label: t`Data exposure`,
      any: t`Any exposure`,
      icon: DatabaseIcon,
      options: dataExposureTypes.map((value) => ({
        value,
        label: i18n._(exposureMeta[value].label),
        media: (
          <StatusDot
            tone={exposureMeta[value].sensitive ? "attention" : "neutral"}
          />
        ),
      })),
    },
    {
      key: "users",
      label: t`Users`,
      any: t`Any number of users`,
      icon: UsersIcon,
      options: usersBuckets.map((value) => ({
        value,
        label: i18n._(usersBucketLabel[value]),
      })),
    },
    {
      key: "owner",
      label: t`Owner`,
      any: t`Any owner`,
      search: t`Search owner`,
      icon: UserIcon,
      options: [
        {
          value: "unowned",
          label: t`No owner`,
          media: <StatusDot tone="attention" />,
        },
        ...owners.map((owner) => ({ value: owner, label: owner })),
      ],
    },
    {
      key: "app",
      label: t`Application`,
      any: t`Any application`,
      search: t`Search application`,
      icon: LayoutGridIcon,
      options: apps
        .toSorted((one, other) => one.name.localeCompare(other.name))
        .map((app) => ({
          value: app.id,
          label: app.name,
          media: <AppLogo name={app.name} size="xs" />,
        })),
    },
  ];

  const needle = search.trim().toLocaleLowerCase();
  const shownDimensions = dimensions.filter(
    (dimension) =>
      needle === "" ||
      dimension.label.toLocaleLowerCase().includes(needle) ||
      dimension.options.some((option) =>
        option.label.toLocaleLowerCase().includes(needle)
      )
  );
  const labelOf = (dimension: Dimension) =>
    dimension.options.find(
      (option) => option.value === filters[dimension.key][0]
    )?.label;

  return (
    <DropdownMenu modal={false} onOpenChange={onOpenChange} open={open}>
      <DropdownMenuTrigger
        closeDelay={hoverDelay.close}
        delay={hoverDelay.open}
        openOnHover
        render={<Button size="sm" variant="ghost" />}
      >
        <SlidersHorizontalIcon data-icon="inline-start" />
        <ToolbarLabel>
          <Trans context="open the filters">Filter</Trans>
        </ToolbarLabel>
        {active > 0 ? <Badge variant="secondary">{active}</Badge> : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <MenuSearch
          onChange={setSearch}
          placeholder={t`Add filter`}
          value={search}
        />
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {shownDimensions.map((dimension) => (
            <DimensionMenu
              current={labelOf(dimension)}
              dimension={dimension}
              key={dimension.key}
              onValueChange={(value) => {
                onChange({
                  ...filters,
                  [dimension.key]: value === "all" ? [] : [value],
                });
              }}
              value={filters[dimension.key][0] ?? "all"}
            />
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <Trans>Quick filters</Trans>
          </DropdownMenuLabel>
          {quickFilters.map((value) => (
            <DropdownMenuCheckboxItem
              checked={filters.show.includes(value)}
              closeOnClick={false}
              key={value}
              onCheckedChange={(checked) => {
                onChange({
                  ...filters,
                  show: checked
                    ? [...filters.show, value]
                    : filters.show.filter((each) => each !== value),
                });
              }}
            >
              <StatusDot tone={quickFilterTone[value]} />
              {i18n._(quickFilterLabel[value])}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
        {active > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={() => {
                  onChange(noFilters);
                }}
              >
                <XIcon />
                <Trans>Clear filters</Trans>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
