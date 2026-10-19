import { Button } from "@grasp-os/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { i18n } from "@lingui/core";
import { plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { SearchIcon } from "lucide-react";
import { useState } from "react";

import { FilterMenu } from "./filter-menu.tsx";
import { OsIcon } from "./os-icon.tsx";
import { coverageCounts, coverageLabel, coverageOf } from "./pulse.ts";
import type { Coverage, PulsePerson } from "./pulse.ts";

// Everyone in the directory and their device with Pulse, as in the
// prototype (`components/pulse-people.tsx`).

export interface PeopleFilters {
  status: string[];
  team: string[];
  os: string[];
}
export const noPeopleFilters: PeopleFilters = { status: [], team: [], os: [] };

const pageSize = 25;
const order: Coverage[] = ["attention", "missing", "offline", "online"];
const dot: Record<Coverage, string> = {
  online: "size-2 flex-none rounded-full bg-status-agreed",
  offline: "size-2 flex-none rounded-full bg-faint",
  attention: "size-2 flex-none rounded-full bg-status-attention",
  missing: "size-2 flex-none rounded-full border border-dashed border-faint",
};
const fill: Record<Coverage, string> = {
  online: "fill-status-agreed",
  offline: "fill-faint",
  attention: "fill-status-attention",
  missing: "fill-border",
};

/** When a device last reported, short: "3 Oct, 14:05". */
const when = (at: string): string =>
  new Intl.DateTimeFormat(i18n.locale, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(at));

/**
 * Everyone on one bar, by state, each state its share of the width. Drawn
 * as shapes, so each share is the shape's own width and needs no style.
 */
const barParts = (
  counts: Record<Coverage, number>,
  total: number
): { status: Coverage; x: number; share: number }[] => {
  const parts: { status: Coverage; x: number; share: number }[] = [];
  let at = 0;
  for (const status of order.toReversed()) {
    const share = (counts[status] / Math.max(total, 1)) * 100;
    if (share > 0) {
      parts.push({ status, x: at, share });
    }
    at += share;
  }
  return parts;
};

const CoverageBar = ({
  counts,
  total,
}: {
  counts: Record<Coverage, number>;
  total: number;
}) => {
  const parts = barParts(counts, total);
  return (
    <svg
      aria-hidden="true"
      className="h-2.5 w-full overflow-hidden rounded-full"
      preserveAspectRatio="none"
    >
      {parts.map(({ status, x, share }) => (
        <rect
          className={`stroke-card stroke-2 ${fill[status]}`}
          height="100%"
          key={status}
          width={`${share}%`}
          x={`${x}%`}
        />
      ))}
    </svg>
  );
};

/** Everyone on one bar, by state. Each part of the legend filters the table to those people. */
export const PulseCoverage = ({
  people,
  onShow,
}: {
  people: readonly PulsePerson[];
  onShow: (status: Coverage) => void;
}) => {
  const counts = coverageCounts(people);
  const reporting = people.length - counts.missing;
  const total = people.length;
  return (
    <div className="flex flex-col gap-3 border-t px-5 py-4">
      <p className="flex items-baseline gap-2">
        <Trans>
          <span className="text-2xl font-medium tracking-tight tabular-nums">
            {reporting} of {total}
          </span>
          <span className="text-muted-foreground">
            <Plural
              one="person has Pulse"
              other="people have Pulse"
              value={total}
            />
          </span>
        </Trans>
      </p>
      <CoverageBar counts={counts} total={total} />
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        {order.toReversed().map((status) => (
          <button
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-2 rounded-sm outline-none focus-visible:ring-3"
            key={status}
            onClick={() => {
              onShow(status);
            }}
            type="button"
          >
            <span aria-hidden="true" className={dot[status]} />
            {i18n._(coverageLabel[status])}
            <span className="text-foreground tabular-nums">
              {counts[status]}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};

type FilterKey = keyof PeopleFilters;
const filterKeys: FilterKey[] = ["status", "team", "os"];
const systems = ["Windows", "macOS", "Linux"] as const;

const tests: Record<
  FilterKey,
  (person: PulsePerson, value: string) => boolean
> = {
  status: (person, value) => coverageOf(person) === value,
  team: (person, value) => person.team === value,
  os: (person, value) => person.device?.os === value,
};

/** A person's state, with what needs attention on hover. */
const PersonStatus = ({ person }: { person: PulsePerson }) => {
  const status = coverageOf(person);
  const note = person.device?.note;
  if (note !== undefined) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex cursor-default items-center gap-2" />
          }
        >
          <span aria-hidden="true" className={dot[status]} />
          <span className="text-status-attention underline decoration-dotted underline-offset-4">
            {i18n._(coverageLabel[status])}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{note}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true" className={dot[status]} />
      <span
        className={status === "attention" ? "text-status-attention" : undefined}
      >
        {i18n._(coverageLabel[status])}
      </span>
    </span>
  );
};

const PersonRow = ({ person }: { person: PulsePerson }) => (
  <TableRow>
    <TableCell variant="section">
      <div className="flex min-w-0 flex-col">
        <span className="truncate">{person.name}</span>
        <span className="text-muted-foreground truncate">{person.email}</span>
        <span className="text-muted-foreground truncate @2xl:hidden">
          {person.team}
        </span>
      </div>
    </TableCell>
    <TableCell className="hidden @2xl:table-cell" variant="section">
      <span className="block truncate">{person.team}</span>
    </TableCell>
    <TableCell className="hidden @3xl:table-cell" variant="section">
      {person.device === null ? (
        <span className="text-muted-foreground">–</span>
      ) : (
        <span className="inline-flex max-w-full items-center gap-2">
          <OsIcon os={person.device.os} />
          <span className="truncate">{person.device.name}</span>
        </span>
      )}
    </TableCell>
    <TableCell className="hidden @xl:table-cell" variant="section">
      <span className="text-muted-foreground tabular-nums">
        {person.device === null ? "–" : when(person.device.lastSeen)}
      </span>
    </TableCell>
    <TableCell className="whitespace-normal" variant="section">
      <PersonStatus person={person} />
    </TableCell>
  </TableRow>
);

/** Everyone in the directory with their device, problems first, 25 to a page. */
export const PulseTable = ({
  people,
  filters,
  onFiltersChange,
}: {
  people: readonly PulsePerson[];
  filters: PeopleFilters;
  onFiltersChange: (filters: PeopleFilters) => void;
}) => {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const needle = query.trim().toLowerCase();

  const matches = (person: PulsePerson, skip?: FilterKey): boolean =>
    (needle === "" ||
      [person.name, person.email, person.device?.name ?? ""].some((text) =>
        text.toLowerCase().includes(needle)
      )) &&
    filterKeys.every(
      (key) =>
        key === skip ||
        filters[key].length === 0 ||
        filters[key].some((value) => tests[key](person, value))
    );
  const shown = people
    .filter((person) => matches(person))
    .toSorted(
      (a, b) =>
        order.indexOf(coverageOf(a)) - order.indexOf(coverageOf(b)) ||
        a.name.localeCompare(b.name)
    );
  const pages = Math.max(Math.ceil(shown.length / pageSize), 1);
  const current = Math.min(page, pages - 1);
  const count = (key: FilterKey, value: string): number =>
    people.filter((person) => matches(person, key) && tests[key](person, value))
      .length;
  const teams = [...new Set(people.map((person) => person.team))].toSorted();
  const change = (next: PeopleFilters): void => {
    onFiltersChange(next);
    setPage(0);
  };
  const total = people.length;
  const matching = shown.length;
  const first = shown.length === 0 ? 0 : current * pageSize + 1;
  const last = Math.min(current * pageSize + pageSize, shown.length);
  const filtered =
    filters.status.length + filters.team.length + filters.os.length > 0 ||
    needle !== "";

  return (
    <div className="flex flex-col border-t">
      <div className="flex flex-wrap items-center gap-2 px-5 py-3">
        <span className="text-muted-foreground mr-auto tabular-nums">
          {matching === total
            ? t`${plural(total, { one: "# person", other: "# people" })}`
            : t`${plural(total, { one: `${matching} of # person`, other: `${matching} of # people` })}`}
        </span>
        <div className="w-60">
          <InputGroup>
            <InputGroupInput
              aria-label={t`Search people and devices`}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
              placeholder={t`Search people and devices`}
              value={query}
            />
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
          </InputGroup>
        </div>
        <FilterMenu
          facets={[
            {
              key: "status",
              title: t`Status`,
              selected: filters.status,
              options: order.map((status) => ({
                value: status,
                label: i18n._(coverageLabel[status]),
                icon: <span aria-hidden="true" className={dot[status]} />,
                count: count("status", status),
              })),
            },
            {
              key: "team",
              title: t`Team`,
              selected: filters.team,
              options: teams.map((team) => ({
                value: team,
                label: team,
                count: count("team", team),
              })),
            },
            {
              key: "os",
              title: t`Device`,
              selected: filters.os,
              options: systems.map((os) => ({
                value: os,
                label: os,
                icon: <OsIcon os={os} />,
                count: count("os", os),
              })),
            },
          ]}
          onChange={(key, selected) => {
            change({ ...filters, [key]: selected });
          }}
          onClear={() => {
            change(noPeopleFilters);
          }}
          onOpenChange={setFilterOpen}
          open={filterOpen}
        />
        {filtered ? (
          <Button
            onClick={() => {
              change(noPeopleFilters);
              setQuery("");
            }}
            size="sm"
            variant="ghost"
          >
            <Trans>Reset</Trans>
          </Button>
        ) : null}
      </div>

      {/* The columns follow the room the table has: on a phone a person is their name and where they stand, with their team under the name. */}
      <div className="@container">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead variant="section">
                <Trans>Person</Trans>
              </TableHead>
              <TableHead
                className="hidden w-40 @2xl:table-cell"
                variant="section"
              >
                <Trans>Team</Trans>
              </TableHead>
              <TableHead
                className="hidden w-44 @3xl:table-cell"
                variant="section"
              >
                <Trans>Device</Trans>
              </TableHead>
              <TableHead
                className="hidden w-32 @xl:table-cell"
                variant="section"
              >
                <Trans>Last seen</Trans>
              </TableHead>
              <TableHead className="w-40" variant="section">
                <Trans>Status</Trans>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length === 0 ? (
              <TableRow>
                <TableCell
                  className="text-center"
                  colSpan={5}
                  variant="section"
                >
                  <p className="text-muted-foreground py-4">
                    <Trans>Nobody matches.</Trans>
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              shown
                .slice(current * pageSize, current * pageSize + pageSize)
                .map((person) => <PersonRow key={person.id} person={person} />)
            )}
          </TableBody>
        </Table>
      </div>

      <div className="text-muted-foreground flex items-center justify-between gap-3 border-t px-5 py-3">
        <span className="tabular-nums">
          <Trans>
            {first}–{last} of {matching}
          </Trans>
        </span>
        <div className="flex gap-2">
          <Button
            disabled={current === 0}
            onClick={() => {
              setPage(current - 1);
            }}
            size="sm"
            variant="outline"
          >
            <Trans context="page">Previous</Trans>
          </Button>
          <Button
            disabled={current >= pages - 1}
            onClick={() => {
              setPage(current + 1);
            }}
            size="sm"
            variant="outline"
          >
            <Trans context="page">Next</Trans>
          </Button>
        </div>
      </div>
    </div>
  );
};
