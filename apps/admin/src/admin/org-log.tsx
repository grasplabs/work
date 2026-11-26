/**
 * The record of one organization, as one list, the newest first, ported
 * from the prototype (grasplabs/prototype `components/admin/org-log.tsx`):
 * what happened at the company (the contract and the agreements, the first
 * conversation, the day the team was told, who talked, what was connected,
 * who came in, each workflow going live), and what a person at Grasp did by
 * hand in this admin. It can be narrowed by what an entry is about, who
 * did it, a team, a day, words in it, or to what went wrong only; a chart
 * shows how busy each day was once the log is long (`chartFrom`), and the
 * day is then picked beside the search, as Damsko's chart draws one series
 * to a bar and takes no press on one. The entries are the model's
 * (`logItemsOf`, `logDays`, `logHours`).
 *
 * Not here, as the prototype has it: what the prototype's Worker noted with
 * its time (each link, each interview, each drawing), which core's snapshot
 * doesn't carry; and exporting what is shown.
 */

import {
  LOG_ACTORS,
  LOG_TOPICS,
  logDays,
  logHours,
  logItemsOf,
} from "@grasp-os/shared/admin/admin-log";
import type { LogItem } from "@grasp-os/shared/admin/admin-log";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import { peopleOf } from "@grasp-os/shared/admin/onboarding-admin";
import type { TrailEntry } from "@grasp-os/shared/admin/trail";
import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent } from "@grasp-os/ui/components/card";
import {
  ChartBar,
  ChartContainer,
  ChartGrid,
  ChartTooltip,
  ChartXAxis,
  ChartYAxis,
} from "@grasp-os/ui/components/chart";
import type { ChartConfig } from "@grasp-os/ui/components/chart";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Text } from "@grasp-os/ui/components/text";
import {
  Icon,
  SearchIcon,
  SlidersHorizontalIcon,
  TriangleAlertIcon,
} from "@grasp-os/ui/lib/icons";
import { colors, font, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { actorWords, logLine, topicWords } from "./log-words.ts";
import { Attention } from "./marks.tsx";
import { Panel } from "./panel.tsx";
import { formatDate } from "./words.ts";

/** How many entries the list shows before it asks to show more. */
const page = 150;

/** How many entries a log has before its days are charted. */
const chartFrom = 30;

/** What two entries saying the same thing may lie apart and still be one. */
const sameMinuteMs = 60_000;

/** Every day together, as the choice of day says it. */
const everyDay = "all";

const busyConfig: ChartConfig = { entries: { label: "Entries" } };

/** A page too narrow for the count beside the tools. */
const narrow = "@media (max-width: 39.99rem)";

/** The width under which who did it is left out of each entry's row. */
const wide = "@container (min-width: 42rem)";

const styles = stylex.create({
  bar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["3"],
  },
  // Said to a screen reader everywhere, shown only where there is room.
  count: {
    fontVariantNumeric: "tabular-nums",
    position: { default: null, [narrow]: "absolute" },
    width: { default: null, [narrow]: 1 },
    height: { default: null, [narrow]: 1 },
    overflow: { default: null, [narrow]: "hidden" },
    clipPath: { default: null, [narrow]: "inset(50%)" },
    whiteSpace: { default: null, [narrow]: "nowrap" },
  },
  tools: {
    display: "flex",
    minWidth: 0,
    flexGrow: 1,
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space["2"],
  },
  search: {
    minWidth: 0,
    flexGrow: { default: 1, "@media (min-width: 40rem)": 0 },
    flexBasis: { default: "10rem", "@media (min-width: 40rem)": "auto" },
    width: { default: null, "@media (min-width: 40rem)": "14rem" },
  },
  day: { width: "11rem", maxWidth: "100%" },
  entries: {
    display: "flex",
    flexDirection: "column",
    containerType: "inline-size",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  entry: {
    display: "flex",
    alignItems: "baseline",
    columnGap: space["4"],
    paddingBlock: space["2"],
    paddingInline: space["5"],
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    fontFamily: font.sans,
    fontSize: font.textSm,
    color: colors.foreground,
  },
  when: {
    width: "9rem",
    flexShrink: 0,
    color: colors.mutedForeground,
    fontSize: font.textXs,
    fontVariantNumeric: "tabular-nums",
  },
  date: { display: "inline-block", width: "6rem" },
  what: { minWidth: 0, flexGrow: 1 },
  who: {
    display: { default: "none", [wide]: "block" },
    width: "12rem",
    flexShrink: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "end",
    color: colors.mutedForeground,
    fontSize: font.textXs,
  },
  more: { display: "flex", justifyContent: "center" },
});

const two = (value: number): string => String(value).padStart(2, "0");

/** The time of a moment, in UTC as the admin's other times are. */
const timeOf = (at: number): string => new Date(at).toISOString().slice(11, 16);

/** "2026-10-14" as "14 Oct", for under the chart. */
const shortDate = (day: string): string =>
  formatDate(day).split(" ").slice(0, 2).join(" ");

/** `count` entries, in words. */
const entriesWords = (count: number): string =>
  `${count} ${count === 1 ? "entry" : "entries"}`;

/** An entry with what it says. */
interface Said {
  item: LogItem;
  text: string;
}

/** What the log can be narrowed by, each a choice of several. */
type Facet = "topic" | "actor" | "team";

/** Each entry with what it says, leaving out what says nothing and what was just said. */
const saidOf = (items: LogItem[]): Said[] =>
  items
    .map((item) => ({ item, text: logLine(item) }))
    // The same thing done twice in the same minute, as when two fields of one form change, is said once.
    .filter((each, index, list) => {
      const before = list[index - 1];
      const same =
        before !== undefined &&
        before.text === each.text &&
        before.item.actor === each.item.actor &&
        before.item.at !== null &&
        each.item.at !== null &&
        Math.abs(before.item.at - each.item.at) < sameMinuteMs;
      return each.text !== "" && !same;
    });

/** How many entries a day's or an hour's row holds, whoever did them. */
const entriesIn = (row: Record<string, unknown>): number => {
  let entries = 0;
  for (const actor of LOG_ACTORS) {
    entries += Number(row[actor] ?? 0);
  }
  return entries;
};

/** How busy each day was, or each hour of a log that is one day long. */
const BusyChart = ({ items }: { items: LogItem[] }) => {
  const days = logDays(items);
  // A log of one day is drawn by the hour.
  const hourly = days.length === 1 && items.some((item) => item.at !== null);
  const data = hourly
    ? logHours(items).map((row) => ({ at: row.hour, entries: entriesIn(row) }))
    : days.map((row) => ({ at: row.day, entries: entriesIn(row) }));
  const said = (value: string | number): string =>
    hourly ? `${two(Number(value))}:00` : shortDate(String(value));
  let [busiest] = data;
  for (const row of data) {
    if (busiest === undefined || row.entries > busiest.entries) {
      busiest = row;
    }
  }
  return (
    <Panel
      description={
        hourly
          ? "Everything so far happened on one day: here by the hour (UTC)."
          : "How many entries each day has. Pick a day beside the search to see only that day."
      }
      title="What happened, day by day"
    >
      <CardContent>
        <ChartContainer
          aria-label={hourly ? "Entries by the hour" : "Entries by day"}
          config={busyConfig}
          data={data}
          height={176}
          summary={
            busiest === undefined
              ? "Nothing yet."
              : `The busiest: ${entriesWords(busiest.entries)} ${hourly ? "at" : "on"} ${said(busiest.at)}.`
          }
          xKey="at"
        >
          <ChartGrid />
          <ChartXAxis valueFormatter={said} />
          <ChartYAxis width={28} />
          <ChartBar dataKey="entries" />
          <ChartTooltip />
        </ChartContainer>
      </CardContent>
    </Panel>
  );
};

/** The choice of day: every day, or one of them, the latest first. */
const DaySelect = ({
  days,
  value,
  onChange,
}: {
  days: string[];
  value: string | null;
  onChange: (day: string | null) => void;
}) => (
  <Select
    items={[
      { value: everyDay, label: "Every day" },
      ...days
        .toReversed()
        .map((day) => ({ value: day, label: formatDate(day) })),
    ]}
    onValueChange={(next) => {
      onChange(next === null || next === everyDay ? null : next);
    }}
    value={value ?? everyDay}
  >
    <SelectTrigger aria-label="Which day to show" size="sm" style={styles.day}>
      <SelectValue />
    </SelectTrigger>
    <SelectContent />
  </Select>
);

/** One choice the log can be narrowed by, with how many entries each option keeps. */
interface FacetOptions {
  key: Facet;
  title: string;
  options: { value: string; label: string; count: number }[];
}

/** The menu that narrows the log by what an entry is about, who did it, and a team. */
const FilterMenu = ({
  facets,
  selected,
  onChange,
}: {
  facets: FacetOptions[];
  selected: Record<Facet, string[]>;
  onChange: (key: Facet, values: string[]) => void;
}) => {
  const chosen =
    selected.topic.length + selected.actor.length + selected.team.length;
  const shown = facets.filter((facet) => facet.options.length > 0);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Icon icon={SlidersHorizontalIcon} />
          {chosen === 0 ? "Filter" : `Filter (${chosen})`}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {shown.map((facet, index) => (
          <DropdownMenuGroup key={facet.key}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>{facet.title}</DropdownMenuLabel>
            {facet.options.map((option) => (
              <DropdownMenuCheckboxItem
                checked={selected[facet.key].includes(option.value)}
                key={option.value}
                onCheckedChange={(checked) => {
                  const others = selected[facet.key].filter(
                    (value) => value !== option.value
                  );
                  onChange(
                    facet.key,
                    checked ? [...others, option.value] : others
                  );
                }}
              >
                {`${option.label} (${option.count})`}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** An organization's Log: everything that happened there, and what Grasp did by hand. */
export const OrgLog = ({
  view,
  trail,
}: {
  view: AdminView;
  trail: TrailEntry[];
}) => {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<Facet, string[]>>({
    topic: [],
    actor: [],
    team: [],
  });
  const [problems, setProblems] = useState(false);
  const [day, setDay] = useState<string | null>(null);
  const [limit, setLimit] = useState(page);

  const { org } = view;
  const people = peopleOf(org);
  const all = saidOf(logItemsOf(view, trail));
  // The team an entry is about: its own, or the team of the person or piece of work it is about.
  const teamOf = (item: LogItem): string =>
    item.team ??
    people.find((each) => each.id === item.person)?.team ??
    org.works.find((each) => each.id === item.work)?.team ??
    "";
  const wanted = query.trim().toLowerCase();
  const matches = (each: Said, skip?: Facet | "day"): boolean =>
    (wanted === "" || each.text.toLowerCase().includes(wanted)) &&
    (!problems || each.item.problem) &&
    (skip === "day" || day === null || each.item.on === day) &&
    (skip === "topic" ||
      filters.topic.length === 0 ||
      filters.topic.includes(each.item.topic)) &&
    (skip === "actor" ||
      filters.actor.length === 0 ||
      filters.actor.includes(each.item.actor)) &&
    (skip === "team" ||
      filters.team.length === 0 ||
      filters.team.includes(teamOf(each.item)));
  const shown = all.filter((each) => matches(each));
  const wrong = all.filter((each) => each.item.problem).length;
  const narrowed =
    wanted !== "" ||
    problems ||
    day !== null ||
    filters.topic.length + filters.actor.length + filters.team.length > 0;
  const listed = shown.slice(0, limit);
  /** How many entries `keep` keeps, among those the other choices keep. */
  const countOf = (facet: Facet, keep: (each: Said) => boolean): number =>
    all.filter((each) => keep(each) && matches(each, facet)).length;
  /** The options of a facet that keep something, or are chosen. */
  const optionsOf = (
    facet: Facet,
    options: { value: string; label: string; count: number }[]
  ) =>
    options.filter(
      (option) => option.count > 0 || filters[facet].includes(option.value)
    );
  const facets: FacetOptions[] = [
    {
      key: "topic",
      title: "What it is about",
      options: optionsOf(
        "topic",
        LOG_TOPICS.map((topic) => ({
          value: topic,
          label: topicWords[topic],
          count: countOf("topic", (each) => each.item.topic === topic),
        }))
      ),
    },
    {
      key: "actor",
      title: "Who did it",
      options: optionsOf(
        "actor",
        LOG_ACTORS.map((actor) => ({
          value: actor,
          label: actorWords[actor],
          count: countOf("actor", (each) => each.item.actor === actor),
        }))
      ),
    },
    {
      key: "team",
      title: "Team",
      options: optionsOf(
        "team",
        org.teams.map((team) => ({
          value: team.id,
          label: team.name,
          count: countOf("team", (each) => teamOf(each.item) === team.id),
        }))
      ),
    },
  ];

  const charted = all.length > chartFrom;
  return (
    <>
      {/* Only a long log is charted: a short one is read as it is. The chart keeps every day in view while one is picked, so another can be picked. */}
      {charted ? (
        <BusyChart
          items={all
            .filter((each) => matches(each, "day"))
            .map((each) => each.item)}
        />
      ) : null}
      <Card aria-label="Every entry" asChild size="sm">
        <section>
          <CardContent>
            <div {...stylex.props(styles.bar)}>
              <Text color="muted">
                <span aria-live="polite" {...stylex.props(styles.count)}>
                  {narrowed
                    ? `${shown.length} of ${all.length} entries`
                    : entriesWords(all.length)}
                </span>
              </Text>
              <div {...stylex.props(styles.tools)}>
                {charted || day !== null ? (
                  <DaySelect
                    days={logDays(all.map((each) => each.item)).map(
                      (each) => each.day
                    )}
                    onChange={setDay}
                    value={day}
                  />
                ) : null}
                {wrong > 0 ? (
                  <Button
                    aria-pressed={problems}
                    onClick={() => {
                      setProblems(!problems);
                    }}
                    size="sm"
                    variant={problems ? "secondary" : "outline"}
                  >
                    <Icon icon={TriangleAlertIcon} />
                    {wrong} went wrong
                  </Button>
                ) : null}
                <InputGroup style={styles.search}>
                  <InputGroupAddon>
                    <Icon icon={SearchIcon} />
                  </InputGroupAddon>
                  <InputGroupInput
                    aria-label="Search the log"
                    onChange={(event) => {
                      setQuery(event.target.value);
                    }}
                    placeholder="Search: a name, a team, a word"
                    value={query}
                  />
                </InputGroup>
                <FilterMenu
                  facets={facets}
                  onChange={(key, values) => {
                    setFilters({ ...filters, [key]: values });
                  }}
                  selected={filters}
                />
              </div>
            </div>
          </CardContent>
          {shown.length === 0 ? (
            <CardContent>
              <Text color="muted">
                {all.length === 0 ? "Nothing yet." : "Nothing matches."}
              </Text>
            </CardContent>
          ) : (
            <CardContent flush>
              <ol {...stylex.props(styles.entries)}>
                {listed.map(({ item, text }, index) => (
                  <li key={item.key} {...stylex.props(styles.entry)}>
                    {/* Its day, said once: on the first entry of each day. */}
                    <span {...stylex.props(styles.when)}>
                      <span {...stylex.props(styles.date)}>
                        {listed[index - 1]?.item.on === item.on
                          ? ""
                          : formatDate(item.on)}
                      </span>
                      {item.at === null ? "" : timeOf(item.at)}
                    </span>
                    <span {...stylex.props(styles.what)}>
                      {item.problem ? <Attention>{text}</Attention> : text}
                    </span>
                    <span {...stylex.props(styles.who)}>
                      {item.actor === "person" && item.person !== undefined
                        ? (people.find((each) => each.id === item.person)
                            ?.name ?? actorWords.person)
                        : actorWords[item.actor]}
                    </span>
                  </li>
                ))}
              </ol>
            </CardContent>
          )}
          {shown.length > limit ? (
            <CardContent>
              <div {...stylex.props(styles.more)}>
                <Button
                  onClick={() => {
                    setLimit(limit + page);
                  }}
                  size="sm"
                  variant="outline"
                >
                  Show more
                </Button>
              </div>
            </CardContent>
          ) : null}
        </section>
      </Card>
    </>
  );
};
