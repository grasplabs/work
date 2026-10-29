import { z } from "zod";

// The widgets Grasp makes for a person's dashboard from what they ask
// (core's dashboard-widgets.ts), as the prototype's "Ask Grasp for a
// widget" (`data/dashboard.ts`, `components/dashboard/widget-library.tsx`).
// A widget is never code: it is a small spec, written by a model, of
// parts the dashboard draws in its own sizes and colours. What keeps it
// within the dashboard:
//
// - Its parts: only these, each with only these settings. A spec with a
//   part or a setting that isn't here doesn't parse, and is never kept.
// - Its numbers: each comes from the person's own rows (`WidgetData`),
//   which core reads as them each time it shows the widget, so a widget
//   never shows a number nobody computed, nor one its person may not see.
// - Its room: every widget is a block of the same size. What a spec needs
//   is counted from its parts (`widgetRoom`), and one that needs more is
//   sent back to be made to fit.
// - That it works: before it is kept a spec is run against the person's
//   rows (`widgetProblems`), so a filter that names nothing of theirs, or
//   matches nothing, is found then.

/** What a widget counts, over its window: a workflow's runs that started, completed, failed or wait now, or its workflows. */
export const widgetMeasures = [
  "started",
  "completed",
  "failed",
  "waiting",
  "workflows",
] as const;
export type WidgetMeasure = (typeof widgetMeasures)[number];

/** What a widget's runs over time count: the runs that started, completed or failed each day. */
export const widgetTrendMeasures = ["started", "completed", "failed"] as const;
export type WidgetTrendMeasure = (typeof widgetTrendMeasures)[number];

/** What rows are put together by: their engine, their workflow, or their workflow's state. */
export const widgetGroupings = ["engine", "workflow", "state"] as const;
export type WidgetGrouping = (typeof widgetGroupings)[number];

/** A workflow's state: its latest run's status, or `none` before its first. */
export const widgetStates = [
  "none",
  "queued",
  "running",
  "waiting",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;
export type WidgetState = (typeof widgetStates)[number];

/** The days a widget looks back over: the last week, or the last 30 days. */
export const widgetWindows = [7, 30] as const;
export type WidgetWindow = (typeof widgetWindows)[number];

/** The columns a widget's table may have: what names a row, then what it counts. */
export const widgetColumns = [
  "engine",
  "workflow",
  "state",
  "started",
  "completed",
  "failed",
  "waiting",
] as const;
export type WidgetColumn = (typeof widgetColumns)[number];

/**
 * One of the person's workflows, as a widget counts it: its engine and
 * itself, by ID and name, its state now, and its runs over the widget's
 * window. Core reads them as the person (dashboard-widgets.ts): only the
 * workflows of the engines they can open.
 */
export interface WidgetRow {
  /** Its engine (App) ID. */
  engine: string;
  engineName: string;
  /** `<engine>/<workflow>`. */
  workflow: string;
  workflowName: string;
  state: WidgetState;
  started: number;
  completed: number;
  failed: number;
  /** Its runs waiting for a decision now. */
  waiting: number;
}

/** A day of the window, oldest first, as a widget's trend counts it. */
export interface WidgetDay {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  started: number;
  completed: number;
  failed: number;
}

/** What a widget is worked out from: the person's rows and days over its window. */
export interface WidgetData {
  days: WidgetWindow;
  rows: WidgetRow[];
  series: WidgetDay[];
}

/** The most of a filter's IDs, and of anything a spec lists. */
const mostIds = 40;

/** A widget's own words: its title, a part's label. */
const label = z.string().trim().min(1).max(60);

/** An ID a filter names: an engine's, or `<engine>/<workflow>`. */
const filterId = z.string().min(1).max(200);

/**
 * Which of the person's rows a part counts: those of these engines, these
 * workflows and these states, each when given. None given counts them all.
 */
const filterSchema = z.strictObject({
  engines: z.array(filterId).min(1).max(mostIds).optional(),
  workflows: z.array(filterId).min(1).max(mostIds).optional(),
  states: z
    .array(z.enum(widgetStates))
    .min(1)
    .max(widgetStates.length)
    .optional(),
});
export type WidgetFilter = z.infer<typeof filterSchema>;

/** The most rows a part lists. */
export const widgetPartRowsMax = 10;

const limit = z.int().min(1).max(widgetPartRowsMax);

const numberPart = z.strictObject({
  type: z.literal("number"),
  label,
  measure: z.enum(widgetMeasures),
  filter: filterSchema.optional(),
});

const barsPart = z.strictObject({
  type: z.literal("bars"),
  label: label.optional(),
  measure: z.enum(widgetMeasures),
  by: z.enum(widgetGroupings),
  filter: filterSchema.optional(),
  /** Largest first (`high`), smallest first, or by name. */
  order: z.enum(["high", "low", "name"]).optional(),
  limit: limit.optional(),
});

const trendPart = z.strictObject({
  type: z.literal("trend"),
  label: label.optional(),
  measure: z.enum(widgetTrendMeasures),
});

const tablePart = z.strictObject({
  type: z.literal("table"),
  label: label.optional(),
  columns: z
    .array(z.enum(widgetColumns))
    .min(1)
    .max(5)
    .refine((columns) => new Set(columns).size === columns.length, {
      message: "Each column may be in the table once.",
    }),
  filter: filterSchema.optional(),
  /** The column its rows are sorted by, largest first; by name without one. */
  sort: z.enum(["started", "completed", "failed", "waiting"]).optional(),
  limit: limit.optional(),
});

const textPart = z.strictObject({
  type: z.literal("text"),
  text: z.string().trim().min(1).max(200),
});

/** A part that stands on its own. */
const leafPart = z.discriminatedUnion("type", [
  numberPart,
  barsPart,
  trendPart,
  tablePart,
  textPart,
]);
export type WidgetLeafPart = z.infer<typeof leafPart>;

/** Parts side by side: two or three, none of them a row itself. */
const rowPart = z.strictObject({
  type: z.literal("row"),
  parts: z.array(leafPart).min(2).max(3),
});

const partSchema = z.discriminatedUnion("type", [
  numberPart,
  barsPart,
  trendPart,
  tablePart,
  textPart,
  rowPart,
]);
export type WidgetPart = z.infer<typeof partSchema>;

/** A widget: its title, the days it looks back over, and its parts, top to bottom. */
export const widgetSpecSchema = z.strictObject({
  title: label,
  days: z.union([z.literal(7), z.literal(30)]),
  parts: z.array(partSchema).min(1).max(4),
});
export type WidgetSpec = z.infer<typeof widgetSpecSchema>;

/** How much room a widget's block has, in the units `widgetRoom` counts. */
export const widgetRoomMax = 6;

/** The room a leaf part takes: a line for a number or words, more for a picture or a table. */
const leafRoom = (part: WidgetLeafPart): number => {
  switch (part.type) {
    case "number":
    case "text": {
      return 1;
    }
    case "trend": {
      return 2;
    }
    case "bars": {
      return (part.limit ?? 5) > 6 ? 3 : 2;
    }
    case "table": {
      return (part.limit ?? 5) > 5 ? 3 : 2;
    }
    default: {
      return 0;
    }
  }
};

/** The room `spec` takes: its parts', a row as much as its tallest. */
export const widgetRoom = (spec: WidgetSpec): number =>
  spec.parts.reduce(
    (room, part) =>
      room +
      (part.type === "row"
        ? Math.max(...part.parts.map(leafRoom))
        : leafRoom(part)),
    0
  );

/** Whether `row` is one `filter` counts. */
const counts = (row: WidgetRow, filter: WidgetFilter | undefined): boolean =>
  (filter?.engines === undefined || filter.engines.includes(row.engine)) &&
  (filter?.workflows === undefined ||
    filter.workflows.includes(row.workflow)) &&
  (filter?.states === undefined || filter.states.includes(row.state));

/** What `row` counts of `measure`. */
const measured = (row: WidgetRow, measure: WidgetMeasure): number =>
  measure === "workflows" ? 1 : row[measure];

/** A bar of a widget: what it stands for, by key (a state's, for a page to name), its name, and its number. */
export interface WidgetBar {
  key: string;
  name: string;
  value: number;
}

/** A cell of a widget's table: a name, a state, or a number. */
export type WidgetCell = string | number;

/** A widget's part as the page draws it, its numbers worked out. */
export type WidgetViewPart =
  | { type: "number"; label: string; measure: WidgetMeasure; value: number }
  | {
      type: "bars";
      label: string | null;
      measure: WidgetMeasure;
      by: WidgetGrouping;
      bars: WidgetBar[];
    }
  | {
      type: "trend";
      label: string | null;
      measure: WidgetTrendMeasure;
      points: { day: string; value: number }[];
    }
  | {
      type: "table";
      label: string | null;
      columns: WidgetColumn[];
      rows: WidgetCell[][];
    }
  | { type: "text"; text: string }
  | { type: "row"; parts: WidgetViewPart[] };

/** A widget as the page draws it: its title, its window, and its parts with their numbers. */
export interface WidgetView {
  title: string;
  days: WidgetWindow;
  parts: WidgetViewPart[];
}

/** The key and name of the group `row` is in. */
const groupOf = (
  row: WidgetRow,
  by: WidgetGrouping
): { key: string; name: string } => {
  switch (by) {
    case "engine": {
      return { key: row.engine, name: row.engineName };
    }
    case "workflow": {
      return { key: row.workflow, name: row.workflowName };
    }
    case "state": {
      return { key: row.state, name: row.state };
    }
    default: {
      return { key: "", name: "" };
    }
  }
};

const barsOf = (
  part: z.infer<typeof barsPart>,
  rows: readonly WidgetRow[]
): WidgetBar[] => {
  const groups = new Map<string, WidgetBar>();
  for (const row of rows) {
    if (!counts(row, part.filter)) {
      continue;
    }
    const { key, name } = groupOf(row, part.by);
    const bar = groups.get(key) ?? { key, name, value: 0 };
    bar.value += measured(row, part.measure);
    groups.set(key, bar);
  }
  const order = part.order ?? "high";
  return [...groups.values()]
    .toSorted((a, b) => {
      if (order === "name") {
        return a.name.localeCompare(b.name);
      }
      const by = order === "high" ? b.value - a.value : a.value - b.value;
      return by === 0 ? a.name.localeCompare(b.name) : by;
    })
    .slice(0, part.limit ?? 5);
};

const cellOf = (row: WidgetRow, column: WidgetColumn): WidgetCell => {
  switch (column) {
    case "engine": {
      return row.engineName;
    }
    case "workflow": {
      return row.workflowName;
    }
    case "state":
    case "started":
    case "completed":
    case "failed":
    case "waiting": {
      return row[column];
    }
    default: {
      return "";
    }
  }
};

const tableOf = (
  part: z.infer<typeof tablePart>,
  rows: readonly WidgetRow[]
): WidgetCell[][] =>
  rows
    .filter((row) => counts(row, part.filter))
    .toSorted((a, b) => {
      const { sort } = part;
      const by = sort === undefined ? 0 : b[sort] - a[sort];
      return by === 0 ? a.workflowName.localeCompare(b.workflowName) : by;
    })
    .slice(0, part.limit ?? 5)
    .map((row) => part.columns.map((column) => cellOf(row, column)));

const viewOf = (part: WidgetPart, data: WidgetData): WidgetViewPart => {
  const { rows, series } = data;
  switch (part.type) {
    case "number": {
      return {
        type: "number",
        label: part.label,
        measure: part.measure,
        value: rows
          .filter((row) => counts(row, part.filter))
          .reduce((sum, row) => sum + measured(row, part.measure), 0),
      };
    }
    case "bars": {
      return {
        type: "bars",
        label: part.label ?? null,
        measure: part.measure,
        by: part.by,
        bars: barsOf(part, rows),
      };
    }
    case "trend": {
      return {
        type: "trend",
        label: part.label ?? null,
        measure: part.measure,
        points: series.map((day) => ({
          day: day.day,
          value: day[part.measure],
        })),
      };
    }
    case "table": {
      return {
        type: "table",
        label: part.label ?? null,
        columns: part.columns,
        rows: tableOf(part, rows),
      };
    }
    case "text": {
      return { type: "text", text: part.text };
    }
    case "row": {
      return {
        type: "row",
        parts: part.parts.map((each) => viewOf(each, data)),
      };
    }
    default: {
      return { type: "text", text: "" };
    }
  }
};

/** `spec` with its numbers worked out from `data`, the person's rows over its window. */
export const widgetView = (spec: WidgetSpec, data: WidgetData): WidgetView => ({
  title: spec.title,
  days: spec.days,
  parts: spec.parts.map((part) => viewOf(part, data)),
});

/** The leaf parts of `spec`, those in its rows too, each with where it stands. */
const leavesOf = (spec: WidgetSpec): { at: string; part: WidgetLeafPart }[] =>
  spec.parts.flatMap((part, index) =>
    part.type === "row"
      ? part.parts.map((each, inner) => ({
          at: `parts[${index}].parts[${inner}]`,
          part: each,
        }))
      : [{ at: `parts[${index}]`, part }]
  );

/**
 * What is wrong with `spec` against the person's rows, in words its
 * maker reads to put it right: a filter naming an engine or a workflow
 * they don't have, a part whose filter matches none of their rows, or a
 * widget that needs more room than a block has. None for one that works.
 */
export const widgetProblems = (
  spec: WidgetSpec,
  { rows }: WidgetData
): string[] => {
  const engines = new Set(rows.map(({ engine }) => engine));
  const workflows = new Set(rows.map(({ workflow }) => workflow));
  const problems: string[] = [];
  for (const { at, part } of leavesOf(spec)) {
    if (part.type === "trend" || part.type === "text") {
      continue;
    }
    const { filter } = part;
    for (const engine of filter?.engines ?? []) {
      if (!engines.has(engine)) {
        problems.push(
          `${at}.filter.engines: "${engine}" is not one of the engines given.`
        );
      }
    }
    for (const workflow of filter?.workflows ?? []) {
      if (!workflows.has(workflow)) {
        problems.push(
          `${at}.filter.workflows: "${workflow}" is not one of the workflows given.`
        );
      }
    }
    if (rows.length > 0 && !rows.some((row) => counts(row, filter))) {
      problems.push(`${at}.filter: it matches none of the workflows.`);
    }
  }
  const room = widgetRoom(spec);
  if (room > widgetRoomMax) {
    problems.push(
      `The widget needs ${room} of the ${widgetRoomMax} units of room a block has: use fewer parts, or shorter lists and tables.`
    );
  }
  return problems;
};

/** The longest answer read as a widget, in characters: one longer is never parsed. */
export const widgetAnswerMaxChars = 12_000;

/** The most problems an answer is sent back with. */
export const widgetProblemsMax = 8;

/** What a model answers with: the widget, and a short note when it made the nearest thing to what was asked. */
const answerSchema = z.strictObject({
  widget: widgetSpecSchema,
  note: z.string().trim().min(1).max(200).optional(),
});

/** A JSON object in an answer, whatever came around it (a code fence, say). */
const objectIn = (text: string): string | undefined => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start === -1 || end < start ? undefined : text.slice(start, end + 1);
};

/**
 * A model's answer as a widget: its spec and note, or the problems that
 * kept it from being one, at most {@link widgetProblemsMax}. Untrusted
 * text: one too long isn't read, and only the spec's own parts and
 * settings parse, so nothing else in it is ever kept.
 */
export const widgetAnswer = (
  text: string
):
  | { ok: true; spec: WidgetSpec; note: string | null }
  | { ok: false; problems: string[] } => {
  if (text.length > widgetAnswerMaxChars) {
    return {
      ok: false,
      problems: [
        `The answer is longer than ${widgetAnswerMaxChars} characters: answer with the widget's JSON alone.`,
      ],
    };
  }
  const json = objectIn(text);
  let parsed: unknown;
  try {
    parsed = json === undefined ? undefined : JSON.parse(json);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    return {
      ok: false,
      problems: ['The answer is not JSON: answer with {"widget": …} alone.'],
    };
  }
  const answer = answerSchema.safeParse(parsed);
  if (!answer.success) {
    return {
      ok: false,
      problems: answer.error.issues
        .slice(0, widgetProblemsMax)
        .map(
          ({ path, message }) =>
            `${path.length === 0 ? "answer" : path.join(".")}: ${message}`
        ),
    };
  }
  return {
    ok: true,
    spec: answer.data.widget,
    note: answer.data.note ?? null,
  };
};

/** The ID of a widget Grasp made: `widget:<uuid>`. */
export const customWidgetIdSchema = z
  .string()
  .regex(/^widget:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u)
  .brand<"CustomWidgetId">();
export type CustomWidgetId = z.infer<typeof customWidgetIdSchema>;

/** The most widgets Grasp made a person's dashboard holds. */
export const customWidgetsMax = 12;

/** What a person asks a widget to be, or to become. */
export const widgetRequestSchema = z.string().trim().min(1).max(500);

/**
 * A widget Grasp made for the person: what they asked of it last, when it
 * was made and last changed, its spec, and how it looks now, worked out
 * from their rows as core read them for this answer.
 */
export interface CustomWidget {
  id: CustomWidgetId;
  asked: string;
  madeAt: string;
  changedAt: string;
  spec: WidgetSpec;
  view: WidgetView;
}

/** A widget Grasp made or changed, and what it says of it when it made the nearest thing to what was asked. */
export interface WidgetMade {
  widget: CustomWidget;
  note: string | null;
}

/** The kinds of a widget's parts, as a widget being written shows them. */
export const widgetPartTypes = [
  "number",
  "bars",
  "trend",
  "table",
  "text",
  "row",
] as const;
export type WidgetPartType = (typeof widgetPartTypes)[number];

/**
 * What can be read of a widget while its answer is still being written:
 * its title so far, and the kinds of its parts in the order they came,
 * a row's own parts after it. Nothing of it is kept or checked: the
 * widget is the answer once it is whole (`widgetAnswer`).
 */
export interface WidgetDraft {
  title: string | null;
  parts: WidgetPartType[];
}

/** Where Grasp is in making or changing a widget, as it streams to the board. */
export type WidgetProgress =
  /** The model is writing the widget, or putting it right after `attempt` 1. */
  | {
      stage: "writing";
      attempt: number;
      attempts: number;
      draft: WidgetDraft;
    }
  /** The answer is checked against the person's own rows. */
  | { stage: "checking"; attempt: number; attempts: number }
  /** It fits, and is being kept. */
  | { stage: "keeping" };

const draftTitlePattern = /"title"\s*:\s*"(?<title>(?:[^"\\]|\\.)*)/u;
const draftPartPattern = /"type"\s*:\s*"(?<type>[a-z]+)"/gu;
const isPartType = (value: string): value is WidgetPartType =>
  widgetPartTypes.some((type) => type === value);

/** A JSON string's characters as far as they came, without a half-written escape. */
const unescaped = (raw: string): string => {
  const whole = raw.replace(/\\(?:u[\da-fA-F]{0,3})?$/u, "");
  try {
    const value: unknown = JSON.parse(`"${whole}"`);
    return typeof value === "string" ? value : whole;
  } catch {
    return whole;
  }
};

/** What can be read of a widget from its answer's `text` so far. */
export const widgetDraftOf = (text: string): WidgetDraft => {
  const read = text.slice(0, widgetAnswerMaxChars);
  const title = draftTitlePattern.exec(read)?.groups?.title;
  return {
    title:
      title === undefined || title === ""
        ? null
        : unescaped(title).slice(0, 60),
    parts: [...read.matchAll(draftPartPattern)].flatMap(({ groups }) => {
      const type = groups?.type ?? "";
      return isPartType(type) ? [type] : [];
    }),
  };
};
