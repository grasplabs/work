import { AppError } from "@grasp-os/sdk";
import type { Infer } from "@grasp-os/sdk";

import { figuresMax, hoursMax, signalsMax, titleMax } from "../schema.ts";
import type { mapFigure } from "../values.ts";

// What a snapshot freezes when the board page takes it: each workflow of
// the map with its hours a week, as drawn, as designed and as it runs, and
// the improvement signals of the App workflows the map links to. Worked
// out here, once, and written into the snapshot, which only `take` writes:
// a later save of a workflow, a new run or a new day's signals never
// changes a snapshot's numbers.
//
// The map works out each workflow's hours from its steps (its
// `figures.list`). As it runs, each run is one pass through its designed
// steps: the minutes a pass takes, at the runs a week its App workflow
// was observed to start over the last `windowDays` days, which the
// platform's statistics count.

export type MapFigure = Infer<typeof mapFigure>;

/** A group of a statistics read: its dimensions, added up. */
interface StatisticGroup {
  dimensions: Record<string, string | null>;
  count: number;
  max: number;
}

/** A statistics read, as the platform takes it. */
interface StatisticQuery {
  measure: "platform.workflow_runs" | "platform.improvement_signals";
  days: number;
  apps: string[];
  offset: number;
  until: string;
  groupBy: string[];
}

/** What a statistics read answers, as the page reads it. */
interface StatisticAnswer {
  groups: StatisticGroup[];
  truncated: boolean;
  unavailable?: string[];
  computation?: string | null;
}

/** The platform's statistics, as the page's resource reads them. */
export type ReadStatistics = (
  query: StatisticQuery
) => Promise<StatisticAnswer>;

/** Most Apps one platform read counts (the platform's bound). */
const appsPerRead = 100;

/** Most groups one read answers (the platform's bound): one page. */
const groupsPerPage = 100;

/**
 * Most pages of one measure a snapshot reads. More groups than that
 * refuse the snapshot (`board.figures_incomplete`) rather than freeze
 * part of them.
 */
const maxPages = 5;

/** Days of runs the observed numbers are from: the signals' window. */
export const windowDays = 30;

const daysPerWeek = 7;
const minutesPerHour = 60;

/** The order the platform ranks improvement signals' kinds in. */
const kindOrder = [
  "waiting_for_person",
  "failing_step",
  "correction",
  "cost_per_run",
  "unanswered_question",
];

/**
 * The refusal of a statistics read, in the host's words, that leaves a
 * snapshot without what runs: a statistics resource no admin bound, or a
 * caller no longer a member (`resource.unavailable`). An App the caller may
 * not see, or that is gone, comes back in a read's `unavailable`, never as
 * a refusal of a read of several Apps. Anything else fails the snapshot: a
 * bound reached (`resource.limit_reached`), taken again later, counts what
 * runs rather than freeze it as unknown, and arguments refused
 * (`resource.invalid_args`) are the page's to fix.
 */
const expectedRefusals: ReadonlySet<string> = new Set(["resource.unavailable"]);

/** The code a refusal carries, if any. */
const codeOf = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : undefined;

/** A refusal with `code`, which the page explains. */
const refusal = (code: string, message: string): Error =>
  new AppError(code, message);

/** Refuses a snapshot whose figures would be incomplete, and why. */
const incomplete = (why: string): Error =>
  refusal(
    "board.figures_incomplete",
    `${why}, so the snapshot's figures would be incomplete.`
  );

/** A key for an App workflow. */
const keyOf = (appId: string, workflowId: string): string =>
  JSON.stringify([appId, workflowId]);

/** Hours to a tenth, and no more than a snapshot holds. */
const tenths = (hours: number): number =>
  Math.min(Math.round(hours * 10) / 10, hoursMax);

/** A title as a snapshot holds it. */
const short = (text: string): string => text.trim().slice(0, titleMax);

/** Every group of a read, page by page, as `allGroups` reads them. */
interface Pages {
  groups: StatisticGroup[];
  /** Of its Apps, those the caller may not see, or that are gone. */
  unavailable: string[];
  /** The improvement-signal computations its pages read: one, or none. */
  computations: Set<string | null>;
}

/**
 * Every group `query` has, page by page, the Apps of it the caller may not
 * see, and the signal computations its pages read. Its `until` holds the
 * window still, and the platform orders groups by their values, so no
 * page overlaps or skips another as runs start meanwhile. Refused with
 * `board.figures_incomplete` past `maxPages`.
 */
const allGroups = async (
  read: ReadStatistics,
  query: Omit<StatisticQuery, "offset">
): Promise<Pages> => {
  const groups: StatisticGroup[] = [];
  const computations = new Set<string | null>();
  for (let page = 0; page < maxPages; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const answer = await read({ ...query, offset: page * groupsPerPage });
    groups.push(...answer.groups);
    if (answer.computation !== undefined) {
      computations.add(answer.computation);
    }
    if (!answer.truncated) {
      return { groups, unavailable: answer.unavailable ?? [], computations };
    }
  }
  throw incomplete(
    `The platform counts more than ${maxPages * groupsPerPage} groups of ${query.measure} for the Apps the map links to`
  );
};

/** `items` in runs of at most `size`. */
const chunksOf = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size)
  );

/**
 * `query` read for each of `chunks` of Apps, each chunk's pages in turn.
 * A chunk refused as expected (not the caller's to use) has all its Apps
 * `unavailable`; any other failure fails the snapshot.
 */
const readChunks = async (
  read: ReadStatistics,
  chunks: readonly string[][],
  query: Omit<StatisticQuery, "offset" | "apps">
): Promise<Pages> => {
  const all: Pages = { groups: [], unavailable: [], computations: new Set() };
  for (const chunk of chunks) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a few chunks, one at a time
      const pages = await allGroups(read, { ...query, apps: chunk });
      all.groups.push(...pages.groups);
      all.unavailable.push(...pages.unavailable);
      for (const computation of pages.computations) {
        all.computations.add(computation);
      }
    } catch (error) {
      const code = codeOf(error);
      if (code === undefined || !expectedRefusals.has(code)) {
        throw error;
      }
      all.unavailable.push(...chunk);
    }
  }
  return all;
};

/**
 * The runs each workflow of the Apps `apps` started in the window ending
 * `until`, and their improvement signals' highest value of each kind, as
 * the platform's statistics count them. The Apps whose runs couldn't be
 * read are `unavailable`, never counted as none. The signals of every
 * page come from one computation: should pages differ, they are read
 * again once, and then the snapshot is refused.
 */
const observed = async (
  read: ReadStatistics,
  apps: readonly string[],
  until: string
) => {
  const runs = new Map<string, number>();
  const signals = new Map<string, Map<string, number>>();
  const chunks = chunksOf(apps, appsPerRead);
  const started = await readChunks(read, chunks, {
    measure: "platform.workflow_runs",
    days: windowDays,
    until,
    groupBy: ["app", "workflow"],
  });
  const readSignals = async () =>
    await readChunks(read, chunks, {
      measure: "platform.improvement_signals",
      days: windowDays,
      until,
      groupBy: ["app", "workflow", "kind"],
    });
  let signalled = await readSignals();
  if (signalled.computations.size > 1) {
    signalled = await readSignals();
    if (signalled.computations.size > 1) {
      throw incomplete(
        "The improvement signals changed twice while they were read"
      );
    }
  }
  for (const { dimensions, count } of started.groups) {
    runs.set(keyOf(dimensions.app ?? "", dimensions.workflow ?? ""), count);
  }
  for (const { dimensions, max } of signalled.groups) {
    const key = keyOf(dimensions.app ?? "", dimensions.workflow ?? "");
    const kinds = signals.get(key) ?? new Map<string, number>();
    kinds.set(dimensions.kind ?? "", max);
    signals.set(key, kinds);
  }
  return {
    runs,
    signals,
    unavailable: new Set([...started.unavailable, ...signalled.unavailable]),
  };
};

/** What a snapshot freezes of one workflow, before its place is set. */
export interface Frozen {
  workflow: string;
  title: string;
  team: string | null;
  state: "drawn" | "designed";
  drawn: {
    version: number;
    hoursPerWeek: number;
    basis: "estimated" | "observed";
  } | null;
  designed: {
    version: number;
    hoursPerWeek: number;
    basis: "estimated" | "observed";
  } | null;
  unavailable: boolean;
  running: {
    appId: string;
    workflowId: string;
    runs: number;
    hoursPerWeek: number;
  } | null;
}

/** A version's hours, as a snapshot holds them. */
const hoursAt = (hours: MapFigure["current"]) => ({
  version: hours.version,
  hoursPerWeek: hours.hoursPerWeek,
  basis: hours.basis,
});

/**
 * What a snapshot freezes of `figure`: its title, team, hours drawn,
 * designed, and as it runs, by the runs its App workflow started in the
 * window; or, when that App's runs couldn't be read, that they are
 * unavailable, never none.
 */
const frozenOf = (
  figure: MapFigure,
  runs: ReadonlyMap<string, number>,
  unavailable: ReadonlySet<string>
): Frozen => {
  const { app } = figure;
  const started =
    app === null ? 0 : (runs.get(keyOf(app.appId, app.workflowId)) ?? 0);
  const weeks = windowDays / daysPerWeek;
  const designed = figure.state === "designed";
  const drawn = designed ? figure.drawn : figure.current;
  const missing = app !== null && unavailable.has(app.appId);
  return {
    workflow: figure.id,
    title: short(figure.title),
    team: figure.team === null ? null : short(figure.team),
    state: figure.state,
    drawn: drawn === null ? null : hoursAt(drawn),
    designed: designed ? hoursAt(figure.current) : null,
    unavailable: missing,
    running:
      app === null || started === 0 || missing
        ? null
        : {
            ...app,
            runs: started,
            hoursPerWeek: tenths(
              ((started / weeks) * figure.current.minutesPerPass) /
                minutesPerHour
            ),
          },
  };
};

/**
 * What a snapshot taken now freezes of the map's workflows `figures`:
 * each with its hours, and the improvement signals of the App workflows
 * they link to, each kind's highest, in the platform's order of kinds,
 * highest first. Refused with `board.too_many_workflows` past
 * `figuresMax`. Without a statistics resource (`read` undefined), every
 * linked App's runs are unavailable.
 */
export const freeze = async (
  figures: readonly MapFigure[],
  read: ReadStatistics | undefined,
  until: string
) => {
  if (figures.length > figuresMax) {
    throw refusal(
      "board.too_many_workflows",
      `A snapshot holds at most ${figuresMax} workflows, and the map has ${figures.length}.`
    );
  }
  const apps = [
    ...new Set(figures.flatMap(({ app }) => (app === null ? [] : [app.appId]))),
  ];
  const { runs, signals, unavailable } =
    read === undefined || apps.length === 0
      ? {
          runs: new Map<string, number>(),
          signals: new Map<string, Map<string, number>>(),
          unavailable: new Set(apps),
        }
      : await observed(read, apps, until);
  const linked = new Map<string, string>();
  for (const { id, app } of figures) {
    const key = app === null ? undefined : keyOf(app.appId, app.workflowId);
    if (key !== undefined && !linked.has(key)) {
      linked.set(key, id);
    }
  }
  const rank = (kind: string): number => {
    const at = kindOrder.indexOf(kind);
    return at === -1 ? kindOrder.length : at;
  };
  const frozenSignals = [...linked].flatMap(([key, workflow]) =>
    [...(signals.get(key) ?? [])].map(([kind, value]) => ({
      workflow,
      kind,
      value,
    }))
  );
  return {
    figures: figures.map((figure) => frozenOf(figure, runs, unavailable)),
    signals: frozenSignals
      .toSorted(
        (a, b) =>
          rank(a.kind) - rank(b.kind) ||
          b.value - a.value ||
          a.workflow.localeCompare(b.workflow)
      )
      .slice(0, signalsMax),
  };
};
