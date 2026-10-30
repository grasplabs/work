import type {
  TodayLane,
  TodayRun,
  WorkflowsToday,
} from "@grasp-os/shared/workflows";

// Today at work (prototype `lib/lanes.ts`): every workflow that did
// something today as a lane, its runs on it in time, so a look says what
// ran, what is running and what waits on whom. A run takes seconds, so
// it is a dot; only waiting has length: a trail from where it started
// waiting to now. Where an item passed from one workflow to the next, a
// light line joins its two dots, and pressing a dot follows that one item
// across the lanes (`journeyOf`). A lane is a workflow, never a person, a
// role or a team. Pure: core serves the day (`workflows.today`), and the
// page only draws it.

/**
 * What one run came to: it ran by itself (`done`), went to people
 * (`toPerson`), waits on the reader (`waits`), waits on someone else
 * (`waitsElsewhere`), or is going on (`running`).
 */
export type LaneState =
  | "done"
  | "toPerson"
  | "waits"
  | "waitsElsewhere"
  | "running";

/** One run on a lane. */
export interface LaneRun {
  id: string;
  /** Its lane's key (`laneKeyOf`). */
  lane: string;
  /** The item it followed: its lineage's first run, which follows it across lanes. */
  key: string;
  /** The run it came from, when the reader sees that one too. */
  from: string | null;
  /** When it started, and ended, in milliseconds; `end` null while it goes on. */
  at: number;
  end: number | null;
  state: LaneState;
  run: TodayRun;
}

/** A workflow's lane. */
export interface Lane {
  key: string;
  name: string;
  of: TodayLane;
  runs: LaneRun[];
  /** A run of it is going on now. */
  running: boolean;
}

export interface LaneDay {
  from: number;
  now: number;
  lanes: Lane[];
  /** The day's oldest runs the reader may see, past what one read takes. */
  cutOff: number;
  /** Runs of the day the reader may not see: counted, never drawn. */
  unseen: number;
}

/** A lane's key: its App and workflow, or its independent workflow. */
export const laneKeyOf = (lane: TodayLane): string =>
  lane.kind === "app"
    ? JSON.stringify(["app", lane.app, lane.workflow])
    : JSON.stringify(["independent", lane.id]);

/** A lane's name, as the page names a workflow. */
const nameOf = (lane: TodayLane): string =>
  lane.kind === "app" ? `${lane.appName} · ${lane.workflow}` : lane.name;

/** What a run came to, as its dot says it. */
export const stateOf = (run: TodayRun): LaneState => {
  if (run.waits !== null) {
    return "waits";
  }
  if (run.waitsOnOthers) {
    return "waitsElsewhere";
  }
  if (run.endedAt === null) {
    return "running";
  }
  return run.went === "people" ? "toPerson" : "done";
};

/**
 * The day as core served it, as lanes: each run a dot in time, each lane
 * in the order core gave them, its runs oldest first. An item is followed
 * by the first run of its lineage the reader sees.
 */
export const laneDay = (today: WorkflowsToday): LaneDay => {
  const byId = new Map(
    today.lanes.flatMap((lane) => lane.runs.map((run) => [run.id, run]))
  );
  /** The first run of `run`'s lineage the reader sees. */
  const keyOf = (run: TodayRun): string => {
    let first = run;
    const visited = new Set<string>();
    while (first.from !== null && !visited.has(first.id)) {
      visited.add(first.id);
      const parent = byId.get(first.from);
      if (parent === undefined) {
        break;
      }
      first = parent;
    }
    return first.id;
  };
  const lanes = today.lanes.map((lane): Lane => {
    const key = laneKeyOf(lane);
    const runs = lane.runs
      .map((run) => ({
        id: run.id,
        lane: key,
        key: keyOf(run),
        from: run.from,
        at: Date.parse(run.startedAt),
        end: run.endedAt === null ? null : Date.parse(run.endedAt),
        state: stateOf(run),
        run,
      }))
      .toSorted((one, other) => one.at - other.at);
    return {
      key,
      name: nameOf(lane),
      of: lane,
      runs,
      running: runs.some(({ end }) => end === null),
    };
  });
  return {
    from: Date.parse(today.from),
    now: Date.parse(today.now),
    lanes,
    cutOff: today.cutOff,
    unseen: today.unseen,
  };
};

/** Where a moment stands across the day, from 0 at its start to 1 at now. */
export const placeOf = (
  at: number,
  day: Pick<LaneDay, "from" | "now">
): number =>
  Math.min(1, Math.max(0, (at - day.from) / Math.max(day.now - day.from, 1)));

/** Every run of the day, across the lanes. */
const allRuns = (day: LaneDay): LaneRun[] =>
  day.lanes.flatMap((lane) => lane.runs);

/** One item's way across the lanes today: every run it had, in order. */
export const journeyOf = (day: LaneDay, key: string): LaneRun[] =>
  allRuns(day)
    .filter((run) => run.key === key)
    .toSorted((one, other) => one.at - other.at);

/** The lines between two runs: from the run an item came from to the run it started. */
export const handovers = (day: LaneDay): { from: LaneRun; to: LaneRun }[] => {
  const runs = allRuns(day);
  const byId = new Map(runs.map((run) => [run.id, run]));
  return runs.flatMap((run) => {
    const from = run.from === null ? undefined : byId.get(run.from);
    return from === undefined ? [] : [{ from, to: run }];
  });
};

/** What waits on the reader now: the day's attention marks. */
export const waiting = (day: LaneDay): LaneRun[] =>
  allRuns(day).filter((run) => run.state === "waits");

const hourMs = 3_600_000;

/** The hours of the day to mark: every whole hour from its start to now, no more than `most`. */
export const hoursOf = (
  day: Pick<LaneDay, "from" | "now">,
  most = 8
): number[] => {
  const first = Math.ceil(day.from / hourMs) * hourMs;
  const hours: number[] = [];
  for (let at = first; at <= day.now; at += hourMs) {
    hours.push(at);
  }
  const every = Math.max(1, Math.ceil(hours.length / most));
  return hours.filter((_, index) => index % every === 0);
};
