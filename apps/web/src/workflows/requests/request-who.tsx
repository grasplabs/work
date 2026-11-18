import { elsewhere } from "@grasp-os/shared/stephen-requests";
import type { RequestsPage } from "@grasp-os/shared/stephen-requests";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { formatNumber } from "../../format.ts";
import { Button } from "../../grasp/button/index.ts";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "../../grasp/empty/index.ts";
import { Search } from "../../grasp/icons/index.ts";
import {
  InputGroup,
  InputGroupInput,
  InputGroupText,
} from "../../grasp/input-group/index.ts";
import { Link } from "../../grasp/link/index.ts";
import { Progress } from "../../grasp/progress/index.ts";
import { FactRow, SettingsRows } from "../../grasp/setting-row/index.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../grasp/table/index.ts";
import { Text } from "../../grasp/text/index.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import { useRequestNames } from "./request-parts.tsx";

// Who asks Stephen, as the prototype's `request-who.tsx`: by team, how
// many of its people asked him against how many can, so a team that has
// not found him yet stands out; and by person, only once an owner turned
// people one by one on, for owners, counts only, with a search.

/** Rows of people shown before "Show more": a page's worth. */
const pageRows = 20;

const styles = stylex.create({
  // How many asked, and the bar of that share beside it.
  asked: { display: "flex", alignItems: "center", gap: grasp.space3 },
  bar: { width: "6rem", flexShrink: 0 },
  people: { display: "flex", flexDirection: "column" },
  tools: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space3,
    paddingBlock: grasp.space3,
    paddingInline: grasp.space4,
  },
  search: { width: "100%", maxWidth: "18rem" },
  more: { paddingBlock: grasp.space2, paddingInline: grasp.space4 },
  off: { paddingInline: grasp.space4 },
});

/**
 * A row's name in a table: words that open what it is about, or plain
 * words for a row about a folded group, which opens nothing.
 */
export const RowName = ({
  name,
  onOpen,
}: {
  name: string;
  onOpen: (() => void) | undefined;
}) =>
  onOpen === undefined ? (
    name
  ) : (
    <Link
      onClick={onOpen}
      render={<button aria-label={name} type="button" />}
      variant="standalone"
    >
      {name}
    </Link>
  );

/** The teams, including the quiet ones; the folded ones are one row that opens nothing. */
export const RequestTeams = ({
  page,
  onOpen,
}: {
  page: RequestsPage;
  onOpen: (teamId: string, name: string) => void;
}) => {
  const { t } = useLingui();
  const names = useRequestNames(page);
  const asking = new Set(page.report.byTeam.map(({ key }) => key));
  // Teams five or more can reach that aren't named are teams too: fewer
  // than five of them asked, none perhaps, which the report folds into
  // Other teams, so their counts stay hidden rather than shown as none.
  const quiet = page.teams
    .filter(({ id, reach }) => reach >= 5 && !asking.has(id))
    .map(({ id, reach }) => ({
      key: id,
      people: 0,
      billed: 0,
      reach,
      hidden: true,
    }));
  const rows = [
    ...page.report.byTeam
      .filter(({ key }) => key !== elsewhere)
      .map((row) => ({ ...row, hidden: false })),
    ...quiet,
    ...page.report.byTeam
      .filter(({ key }) => key === elsewhere)
      .map((row) => ({ ...row, hidden: false })),
  ];
  return (
    <Table
      aria-label={t({
        message: "Teams",
        context: "Stephen's requests by team",
      })}
    >
      <TableHeader>
        <TableRow>
          <TableHead>{t({ message: "Team", context: "column" })}</TableHead>
          <TableHead>{t`People who asked`}</TableHead>
          <TableHead align="end">
            {t({ message: "Requests", context: "column: billed requests" })}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const asked = formatNumber(row.people);
          const of = formatNumber(row.reach);
          const reach = of;
          const name = names.team(row.key);
          let askedText = row.reach > 0 ? t`${asked} of ${of}` : asked;
          if (row.hidden) {
            askedText = t`Fewer than five of ${reach} asked him`;
          }
          const opens = row.key !== elsewhere && !row.hidden;
          return (
            <TableRow key={row.key}>
              <TableCell lead>
                <RowName
                  name={name}
                  onOpen={
                    opens
                      ? () => {
                          onOpen(row.key, name);
                        }
                      : undefined
                  }
                />
              </TableCell>
              <TableCell>
                <span {...stylex.props(styles.asked)}>
                  {row.hidden ? null : (
                    <Progress
                      label={t`Share of ${name} who asked`}
                      layout={styles.bar}
                      size="sm"
                      value={Math.min(
                        100,
                        Math.round(
                          (row.reach > 0 ? row.people / row.reach : 0) * 100
                        )
                      )}
                    />
                  )}
                  <Text element="span" size="sm" tone="muted">
                    {askedText}
                  </Text>
                </span>
              </TableCell>
              <TableCell align="end">
                {row.hidden ? null : formatNumber(row.billed)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
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
  onOpen: (personId: string, name: string) => void;
}) => {
  const { t } = useLingui();
  const names = useRequestNames(page);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(pageRows);
  const canSwitch = page.canSetPerPerson;
  const { byPerson } = page.report;
  if (byPerson === null) {
    return (
      <div {...stylex.props(styles.off)}>
        <SettingsRows>
          <FactRow
            help={t`In the Netherlands the works council may need to agree before you turn this on.`}
            label={
              page.settings.requestsPerPerson
                ? t`Owners see people one by one.`
                : t`People one by one are off`
            }
          >
            {canSwitch && !page.settings.requestsPerPerson ? (
              <Button
                disabled={busy}
                onClick={() => {
                  onSwitch(true);
                }}
                size="sm"
                variant="quiet"
              >
                {t`Show people one by one`}
              </Button>
            ) : null}
            {canSwitch || page.settings.requestsPerPerson ? null : (
              <Text element="span" size="sm" tone="muted">
                {t`An owner can turn this on.`}
              </Text>
            )}
          </FactRow>
        </SettingsRows>
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
    <div {...stylex.props(styles.people)}>
      <div {...stylex.props(styles.tools)}>
        <InputGroup layout={styles.search}>
          <InputGroupText icon={Search} />
          <InputGroupInput
            aria-label={t`Search people`}
            onValueChange={setQuery}
            placeholder={t`Search people`}
            type="search"
            value={query}
          />
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
      {rows.length === 0 ? (
        <Empty size="inline">
          <EmptyHeader>
            <EmptyDescription>{t`Nobody by that name`}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table
          aria-label={t({
            message: "People",
            context: "Stephen's requests by person",
          })}
        >
          <TableHeader>
            <TableRow>
              <TableHead>{t`Person`}</TableHead>
              <TableHead align="end">
                {t({ message: "Requests", context: "column: billed requests" })}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.slice(0, shown).map((row) => (
              <TableRow key={row.key}>
                <TableCell lead>
                  <RowName
                    name={row.name}
                    onOpen={() => {
                      onOpen(row.key, row.name);
                    }}
                  />
                </TableCell>
                <TableCell align="end">{formatNumber(row.billed)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {rows.length > shown ? (
        <div {...stylex.props(styles.more)}>
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
