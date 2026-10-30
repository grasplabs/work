import { elsewhere } from "@grasp-os/shared/stephen-requests";
import type { RequestsPage } from "@grasp-os/shared/stephen-requests";
import { Button } from "@grasp-os/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import { SearchIcon } from "lucide-react";
import { useState } from "react";

import { formatNumber } from "../../format.ts";
import { OpenRow, ShareBar, useRequestNames } from "./request-parts.tsx";

// Who asks Stephen, as the prototype's `request-who.tsx`: by team, how
// many of its people asked him against how many can, so a team that has
// not found him yet stands out; and by person, only once an owner turned
// people one by one on, for owners, counts only, with a search.

/** Rows of people shown before "Show more": a screen's worth. */
const pageRows = 20;

/**
 * A team's row: its name, its requests and the chevron, with how many
 * asked on a line of its own under them until there is room for that and
 * its bar beside the name.
 */
const teamRow =
  "flex flex-wrap items-center gap-x-6 gap-y-1 px-6 py-3 @2xl:flex-nowrap";
const nameCell = "min-w-0 flex-1";
const askedCell =
  "order-last basis-full @2xl:order-none @2xl:w-36 @2xl:flex-none";
const barCell = "hidden w-36 flex-none @2xl:block";
const countCell = "w-18 flex-none text-right tabular-nums";

/** The teams, including the quiet ones; the folded ones are one row that opens nothing. */
export const RequestTeams = ({
  page,
  onOpen,
}: {
  page: RequestsPage;
  onOpen: (teamId: string) => void;
}) => {
  const { t } = useLingui();
  const names = useRequestNames(page);
  const asking = new Set(page.report.byTeam.map(({ key }) => key));
  // Teams five or more can reach that nobody of asked are teams too.
  const quiet = page.teams
    .filter(({ id, reach }) => reach >= 5 && !asking.has(id))
    .map(({ id, reach }) => ({ key: id, people: 0, billed: 0, reach }));
  const rows = [
    ...page.report.byTeam.filter(({ key }) => key !== elsewhere),
    ...quiet,
    ...page.report.byTeam.filter(({ key }) => key === elsewhere),
  ];
  return (
    <ul className="@container mt-3">
      <li
        aria-hidden="true"
        className="text-muted-foreground hidden gap-x-6 px-6 pb-2 text-xs @2xl:flex"
      >
        <span className={nameCell}>
          {t({ message: "Team", context: "column" })}
        </span>
        <span className={askedCell}>{t`People who asked`}</span>
        <span className={barCell} />
        <span className={countCell}>
          {t({ message: "Requests", context: "column: billed requests" })}
        </span>
        <span className="size-4 flex-none" />
      </li>
      {rows.map((row) => {
        const asked = formatNumber(row.people);
        const of = formatNumber(row.reach);
        const name = names.team(row.key);
        return (
          <OpenRow
            className={teamRow}
            key={row.key}
            onOpen={
              row.key === elsewhere
                ? undefined
                : () => {
                    onOpen(row.key);
                  }
            }
          >
            <span className={cn("truncate", nameCell)}>{name}</span>
            <span
              className={cn(
                "text-muted-foreground text-xs tabular-nums @2xl:text-sm",
                askedCell
              )}
            >
              {row.reach > 0 ? t`${asked} of ${of}` : asked}
            </span>
            <span className={barCell}>
              <ShareBar
                label={t`Share of ${name} who asked`}
                share={row.reach > 0 ? row.people / row.reach : 0}
              />
            </span>
            <span className={countCell}>{formatNumber(row.billed)}</span>
          </OpenRow>
        );
      })}
    </ul>
  );
};

/**
 * People one by one: only once an owner turned them on, and then for
 * owners. In the Netherlands the works council may need to agree first.
 */
export const RequestPeople = ({
  page,
  busy,
  onSwitch,
  onOpen,
}: {
  page: RequestsPage;
  busy: boolean;
  onSwitch: (on: boolean) => void;
  onOpen: (personId: string) => void;
}) => {
  const { t } = useLingui();
  const names = useRequestNames(page);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(pageRows);
  const canSwitch = page.canSetPerPerson;
  const { byPerson } = page.report;
  if (byPerson === null) {
    return (
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t px-6 py-4">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span>
            {page.settings.requestsPerPerson
              ? t`Owners see people one by one.`
              : t`People one by one are off`}
          </span>
          <span className="text-muted-foreground">
            {t`In the Netherlands the works council may need to agree before you turn this on.`}
          </span>
        </span>
        {canSwitch && !page.settings.requestsPerPerson ? (
          <Button
            disabled={busy}
            onClick={() => {
              onSwitch(true);
            }}
            size="sm"
            variant="outline"
          >
            {t`Show people one by one`}
          </Button>
        ) : null}
        {canSwitch || page.settings.requestsPerPerson ? null : (
          <span className="text-muted-foreground">
            {t`An owner can turn this on.`}
          </span>
        )}
      </div>
    );
  }
  const needle = query.trim().toLocaleLowerCase();
  const rows = byPerson
    .map((row) => ({ ...row, name: names.person(row.key) }))
    .filter(
      (row) => needle === "" || row.name.toLocaleLowerCase().includes(needle)
    );
  const left = formatNumber(rows.length - shown);
  return (
    <div className="flex flex-col">
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t px-6 py-3">
        <InputGroup className="sm:max-w-72">
          <InputGroupInput
            aria-label={t`Search people`}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder={t`Search people`}
            value={query}
          />
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
        </InputGroup>
        {canSwitch ? (
          <Button
            disabled={busy}
            onClick={() => {
              onSwitch(false);
            }}
            size="sm"
            variant="ghost"
          >
            {t`Hide people one by one`}
          </Button>
        ) : null}
      </div>
      <ul>
        {rows.slice(0, shown).map((row) => (
          <OpenRow
            className="flex items-center gap-x-6 px-6 py-2.5"
            key={row.key}
            onOpen={() => {
              onOpen(row.key);
            }}
          >
            <span className="min-w-0 flex-1 truncate">{row.name}</span>
            <span className="tabular-nums">{formatNumber(row.billed)}</span>
          </OpenRow>
        ))}
        {rows.length === 0 ? (
          <li className="text-muted-foreground border-t px-6 py-6 text-center">
            {t`Nobody by that name`}
          </li>
        ) : null}
      </ul>
      {rows.length > shown ? (
        <div className="border-t px-4 py-2">
          <Button
            onClick={() => {
              setShown(shown + pageRows * 5);
            }}
            size="sm"
            variant="ghost"
          >
            {t`Show more · ${left} left`}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
