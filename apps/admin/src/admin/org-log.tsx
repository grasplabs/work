/**
 * The record of one organization, as one list, the newest first, ported
 * from the prototype (grasplabs/prototype `components/admin/org-log.tsx`):
 * what happened at the company (the contract and the agreements, the first
 * conversation, the day the team was told, who talked, what was connected,
 * who came in, each workflow going live), and what a person at Grasp did by
 * hand in this admin. It can be narrowed by what an entry is about, who
 * did it, a team, a day, words in it, or to what went wrong only; a chart
 * shows how busy each day was, by who did it, once the log is long
 * (`chartFrom`), and a day is picked by pressing its bar. The entries are
 * the model's (`logItemsOf`, `logDays`, `logHours`).
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
  ChartLegend,
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
import { Text } from "@grasp-os/ui/components/text";
import {
  Icon,
  SearchIcon,
  SlidersHorizontalIcon,
  TriangleAlertIcon,
  XIcon,
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

/** Who did it, each a part of a day's bar, in the chart's tones in this order. */
const busyConfig: ChartConfig = Object.fromEntries(
  LOG_ACTORS.map((actor) => [actor, { label: actorWords[actor] }])
);

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

/** "14 Oct 2026" as "14 Oct", along the chart's foot. */
const shortDate = (said: string | number): string =>
  String(said).split(" ").slice(0, 2).join(" ");

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

/** What each of who did it did in a day's or an hour's row. */
const countsOf = (row: Record<string, unknown>): Record<string, number> =>
  Object.fromEntries(
    LOG_ACTORS.map((actor) => [actor, Number(row[actor] ?? 0)])
  );

/** How busy each day was, or each hour of a log that is one day long, by who did it. */
const BusyChart = ({
  items,
  day,
  onDay,
}: {
  items: LogItem[];
  day: string | null;
  onDay: (day: string | null) => void;
}) => {
  const days = logDays(items);
  // A log of one day is drawn by the hour.
  const hourly = days.length === 1 && items.some((item) => item.at !== null);
  // Each row as it is read ("14 Oct 2026", "09:00"), with who did how much.
  const data = hourly
    ? logHours(items).map((row) => ({
        at: `${two(row.hour)}:00`,
        ...countsOf(row),
      }))
    : days.map((row) => ({ at: formatDate(row.day), ...countsOf(row) }));
  let busiest: { at: string; entries: number } | undefined;
  for (const row of data) {
    const entries = entriesIn(row);
    if (busiest === undefined || entries > busiest.entries) {
      busiest = { at: row.at, entries };
    }
  }
  const picked = days.findIndex((each) => each.day === day);
  return (
    <Panel
      description={
        hourly
          ? "Everything so far happened on one day: here by the hour (UTC)."
          : "Press a day to see only that day."
      }
      title="What happened, by who did it"
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
              : `The busiest: ${entriesWords(busiest.entries)} ${hourly ? "at" : "on"} ${busiest.at}.`
          }
          xKey="at"
          {...(hourly
            ? {}
            : {
                // Pressing the day shown alone shows every day again.
                onRowClick: (_row: unknown, index: number) => {
                  const pressed = days[index]?.day ?? null;
                  onDay(pressed === day ? null : pressed);
                },
                selectedIndex: picked === -1 ? null : picked,
              })}
        >
          <ChartGrid />
          <ChartXAxis valueFormatter={hourly ? undefined : shortDate} />
          <ChartYAxis width={28} />
          {LOG_ACTORS.map((actor) => (
            <ChartBar
              dataKey={actor}
              key={actor}
              stackId={hourly ? "hour" : "day"}
            />
          ))}
          <ChartTooltip />
          <ChartLegend />
        </ChartContainer>
      </CardContent>
    </Panel>
  );
};

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
          day={day}
          items={all
            .filter((each) => matches(each, "day"))
            .map((each) => each.item)}
          onDay={setDay}
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
                {day === null ? null : (
                  <Button
                    aria-label="Show every day again"
                    onClick={() => {
                      setDay(null);
                    }}
                    size="sm"
                    variant="secondary"
                  >
                    {formatDate(day)}
                    <Icon icon={XIcon} />
                  </Button>
                )}
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
