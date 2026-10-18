/**
 * The record of one organization, as one list, the newest first, ported
 * from the prototype (grasplabs/prototype `components/admin/org-log.tsx`):
 * what happened at the company (the contract and the agreements, the first
 * conversation, the day the team was told, who talked, what was connected,
 * who came in, each workflow going live), and what a person at Grasp did by
 * hand in this console. It can be narrowed by what an entry is about, who
 * did it, a team, a day, words in it, or to what went wrong only; a chart
 * shows how busy each day was. The entries are the model's (`logItemsOf`,
 * `logDays`, `logHours`).
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
import type { LogActor, LogItem } from "@grasp-os/shared/admin/admin-log";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import { peopleOf } from "@grasp-os/shared/admin/onboarding-admin";
import type { TrailEntry } from "@grasp-os/shared/admin/trail";
import { Button } from "@grasp-os/ui/components/button";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  XAxis,
  YAxis,
  chartColor,
} from "@grasp-os/ui/components/chart";
import type { ChartColor, ChartConfig } from "@grasp-os/ui/components/chart";
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
import { cn } from "@grasp-os/ui/lib/utils";
import {
  ListFilterIcon,
  SearchIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { actorWords, logLine, topicWords } from "./log-words.ts";
import { Panel } from "./panel.tsx";
import { formatDate } from "./words.ts";

/** How many entries the list shows before it asks to show more. */
const page = 150;

/** What two entries saying the same thing may lie apart and still be one. */
const sameMinuteMs = 60_000;

/** Each of who did it in the chart's own shade. */
const actorColors: Record<LogActor, ChartColor> = {
  grasp: "chart-1",
  company: "chart-3",
  person: "chart-4",
  itself: "chart-2",
};

/** The same shades, for the legend under the chart. */
const swatches: Record<LogActor, string> = {
  grasp: "bg-chart-1",
  company: "bg-chart-3",
  person: "bg-chart-4",
  itself: "bg-chart-2",
};

const chartConfig: ChartConfig = Object.fromEntries(
  LOG_ACTORS.map((actor) => [
    actor,
    { label: actorWords[actor], color: actorColors[actor] },
  ])
);

const two = (value: number): string => String(value).padStart(2, "0");

/** The time of a moment, in UTC as the console's other times are. */
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

/** How busy each day was, or each hour of a log that is one day long. */
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
  let description = "Press a day to see only that day.";
  if (days.length === 0) {
    description = "Nothing has happened here yet.";
  } else if (hourly) {
    description =
      "Everything so far happened on one day: here by the hour (UTC).";
  }
  return (
    <Panel description={description} title="What happened, by who did it">
      {days.length === 0 ? null : (
        <div className="border-t px-3 pt-4 pb-2">
          <ChartContainer
            className="aspect-auto h-44 w-full"
            config={chartConfig}
          >
            {hourly ? (
              <BarChart data={logHours(items)}>
                <CartesianGrid vertical={false} />
                <XAxis
                  axisLine={false}
                  dataKey="hour"
                  tickFormatter={(hour: number) => `${two(hour)}:00`}
                  tickLine={false}
                  ticks={[0, 6, 12, 18, 23]}
                />
                <YAxis
                  allowDecimals={false}
                  axisLine={false}
                  tickLine={false}
                  width={28}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                {LOG_ACTORS.map((actor) => (
                  <Bar
                    dataKey={actor}
                    fill={chartColor(actorColors[actor])}
                    isAnimationActive={false}
                    key={actor}
                    maxBarSize={28}
                    stackId="hour"
                  />
                ))}
              </BarChart>
            ) : (
              <BarChart
                data={days}
                onClick={(state) => {
                  const label = state?.activeLabel;
                  if (typeof label === "string") {
                    onDay(day === label ? null : label);
                  }
                }}
              >
                <CartesianGrid vertical={false} />
                <XAxis
                  axisLine={false}
                  dataKey="day"
                  minTickGap={24}
                  tickFormatter={shortDate}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  axisLine={false}
                  tickLine={false}
                  width={28}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(label) =>
                        typeof label === "string" ? formatDate(label) : ""
                      }
                    />
                  }
                />
                {LOG_ACTORS.map((actor) => (
                  <Bar
                    className="cursor-pointer"
                    dataKey={actor}
                    fill={chartColor(actorColors[actor])}
                    isAnimationActive={false}
                    key={actor}
                    maxBarSize={28}
                    stackId="day"
                  />
                ))}
              </BarChart>
            )}
          </ChartContainer>
          {/* Its own legend, so it wraps where the page is narrow. */}
          <ul className="text-muted-foreground flex flex-wrap justify-center gap-x-4 gap-y-1 px-2 pt-3 pb-1 text-xs">
            {LOG_ACTORS.map((actor) => (
              <li className="flex items-center gap-1.5" key={actor}>
                <span
                  aria-hidden
                  className={cn("size-2 flex-none rounded-xs", swatches[actor])}
                />
                {actorWords[actor]}
              </li>
            ))}
          </ul>
        </div>
      )}
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
      <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
        <ListFilterIcon data-icon="inline-start" />
        {chosen === 0 ? "Filter" : `Filter (${chosen})`}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
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
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {option.count}
                </span>
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
  const groups = [...new Set(listed.map((each) => each.item.on))].map((on) => ({
    on,
    entries: listed.filter((each) => each.item.on === on),
  }));
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

  return (
    <>
      {/* The chart keeps every day in view while one is picked, so another can be picked from it. */}
      <BusyChart
        day={day}
        items={all
          .filter((each) => matches(each, "day"))
          .map((each) => each.item)}
        onDay={setDay}
      />
      <section className="bg-card overflow-hidden rounded-xl border">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
          <span
            aria-live="polite"
            className="text-muted-foreground tabular-nums max-sm:sr-only"
          >
            {narrowed
              ? `${shown.length} of ${all.length} entries`
              : entriesWords(all.length)}
          </span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
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
                <XIcon data-icon="inline-end" />
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
                <TriangleAlertIcon data-icon="inline-start" />
                {wrong} went wrong
              </Button>
            ) : null}
            <div className="min-w-0 flex-1 basis-40 sm:w-56 sm:flex-none sm:basis-auto">
              <InputGroup>
                <InputGroupInput
                  aria-label="Search the log"
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                  placeholder="Search: a name, a team, a word"
                  value={query}
                />
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
              </InputGroup>
            </div>
            <FilterMenu
              facets={facets}
              onChange={(key, values) => {
                setFilters({ ...filters, [key]: values });
              }}
              selected={filters}
            />
          </div>
        </div>
        {shown.length === 0 ? (
          <p className="text-muted-foreground border-t px-5 py-4">
            {all.length === 0 ? "Nothing yet." : "Nothing matches."}
          </p>
        ) : (
          <ol className="@container flex flex-col">
            {groups.map((group) => (
              <li key={group.on}>
                <div className="bg-muted/50 text-muted-foreground flex items-baseline justify-between gap-3 border-t px-5 py-1.5 text-xs">
                  <span>{formatDate(group.on)}</span>
                  <span className="tabular-nums">{group.entries.length}</span>
                </div>
                <ul className="flex flex-col">
                  {group.entries.map(({ item, text }) => (
                    <li
                      className="flex items-baseline gap-x-4 border-t px-5 py-2"
                      key={item.key}
                    >
                      <span className="text-muted-foreground w-11 flex-none text-xs tabular-nums">
                        {item.at === null ? "" : timeOf(item.at)}
                      </span>
                      <span
                        className={cn(
                          "min-w-0 flex-1",
                          item.problem && "text-status-attention"
                        )}
                      >
                        {text}
                      </span>
                      <span className="text-muted-foreground hidden w-48 flex-none truncate text-right text-xs @2xl:block">
                        {item.actor === "person" && item.person !== undefined
                          ? (people.find((each) => each.id === item.person)
                              ?.name ?? actorWords.person)
                          : actorWords[item.actor]}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
        {shown.length > limit ? (
          <div className="flex justify-center border-t px-5 py-3">
            <Button
              onClick={() => {
                setLimit(limit + page);
              }}
              size="sm"
              variant="ghost"
            >
              Show more
            </Button>
          </div>
        ) : null}
      </section>
    </>
  );
};
