// An app's tools made legible: grouped by what they act on (Contacts, Deals, Pipelines…), read from
// their names where the host gives no group; counted, read against change; and a few plain sentences
// of what the app can do, from its largest groups. Words for the sentences are the host's (words.ts).
import type { AppTool, AppToolChoice } from "./model";

/** The verbs a tool's name may start with, before what it acts on ("Batch read", "List"). */
const VERBS = new Set([
  "add",
  "archive",
  "associate",
  "batch",
  "cancel",
  "clone",
  "close",
  "complete",
  "copy",
  "count",
  "create",
  "delete",
  "download",
  "duplicate",
  "edit",
  "enroll",
  "export",
  "fetch",
  "find",
  "get",
  "import",
  "invite",
  "link",
  "list",
  "lookup",
  "mark",
  "merge",
  "move",
  "post",
  "publish",
  "read",
  "remove",
  "rename",
  "reply",
  "restore",
  "retrieve",
  "run",
  "search",
  "send",
  "set",
  "share",
  "start",
  "stop",
  "submit",
  "sync",
  "unlink",
  "update",
  "upload",
  "upsert",
  "view",
  "a",
  "an",
  "all",
  "the",
  "new",
  "many",
  "multiple",
  "one",
  "and",
  "or",
]);

/** A word as a group's name: capitalised, in the plural ("contact" → "Contacts"). */
const plural = (word: string) => {
  const lower = word.toLowerCase();
  let many = `${lower}s`;
  if (lower.endsWith("s")) {
    many = lower;
  } else if (/[^aeiou]y$/u.test(lower)) {
    many = `${lower.slice(0, -1)}ies`;
  } else if (/(?:x|ch|sh)$/u.test(lower)) {
    many = `${lower}es`;
  }
  return many.charAt(0).toUpperCase() + many.slice(1);
};

/** What a tool acts on, from its name: the first word after its verbs ("Batch read companies" → "Companies"). */
export const groupOf = (tool: AppTool) => {
  if (tool.group !== undefined && tool.group !== "") {
    return tool.group;
  }
  const words = tool.name
    .split(/[\s_-]+/u)
    .filter((word) => /\p{L}/u.test(word));
  const object = words.find((word) => !VERBS.has(word.toLowerCase()));
  return object === undefined ? null : plural(object);
};

/** One group of tools, with its counts. */
export interface ToolGroup {
  /** What they act on ("Contacts"), or null for the rest. */
  name: string | null;
  tools: AppTool[];
  reads: number;
  writes: number;
  /** How many Grasp may use. */
  allowed: number;
}

/** A group's tools counted. */
const counted = (name: string | null, tools: AppTool[]): ToolGroup => ({
  name,
  tools,
  reads: tools.filter((tool) => tool.kind === "read").length,
  writes: tools.filter((tool) => tool.kind === "write").length,
  allowed: tools.filter((tool) => tool.choice !== "never").length,
});

/**
 * The tools by what they act on, in the order the host gives them (what people use first), those Grasp
 * may use ahead of the rest; groups of one tool go together at the end
 * (null), so a long list does not end in a run of one-tool groups.
 */
export const groupTools = (tools: readonly AppTool[]): ToolGroup[] => {
  const byName = new Map<string, AppTool[]>();
  const loose: AppTool[] = [];
  for (const tool of tools) {
    const name = groupOf(tool);
    if (name === null) {
      loose.push(tool);
    } else {
      byName.set(name, [...(byName.get(name) ?? []), tool]);
    }
  }
  const groups: ToolGroup[] = [];
  // A Map keeps the order each group was first met in: the host's.
  for (const [name, members] of byName) {
    if (members.length > 1) {
      groups.push(counted(name, members));
    } else {
      loose.push(...members);
    }
  }
  // The host's order (what people use first), those Grasp may use ahead of it.
  const ordered = groups.toSorted(
    (a, b) => Number(b.allowed > 0) - Number(a.allowed > 0)
  );
  return loose.length > 0 ? [...ordered, counted(null, loose)] : ordered;
};

/** What a group's tools may do, as one of its presets, or `mixed` when they differ from all three. */
export type GroupPreset = "off" | "read" | "all" | "mixed";

/** What a tool may do under a group's preset: off, reads only, or reads and asked changes. */
export const choiceUnder = (
  preset: Exclude<GroupPreset, "mixed">,
  tool: AppTool
): AppToolChoice => {
  if (preset === "off") {
    return "never";
  }
  if (tool.kind === "read") {
    return "read";
  }
  return preset === "all" ? "write" : "never";
};

/** The preset a group's tools stand at now. */
export const presetOf = (tools: readonly AppTool[]): GroupPreset =>
  (["off", "read", "all"] as const).find((preset) =>
    tools.every((tool) => tool.choice === choiceUnder(preset, tool))
  ) ?? "mixed";

/** The choices a tool may take: a tool that changes something may never run without asking. */
export const choicesFor = (tool: AppTool): AppToolChoice[] =>
  tool.kind === "read" ? ["never", "read", "write"] : ["never", "write"];

/** One of the plain sentences of what an app can do: its words, and whether it changes anything. */
export interface ToolExample {
  sentence: string;
  writes: boolean;
}

/**
 * A few plain sentences of what the app can do, from its groups (what Grasp may use first, then the
 * largest): what it finds in the first two, what it changes in the first, then the next ones in turn
 * ("Find contacts and companies", "Create and change contacts").
 */
export const examplesOf = (
  groups: readonly ToolGroup[],
  words: {
    exampleRead: (groups: string) => string;
    exampleWrite: (groups: string) => string;
    and: (a: string, b: string) => string;
  },
  count = 4
): ToolExample[] => {
  const named = groups.filter(
    (group): group is ToolGroup & { name: string } => group.name !== null
  );
  const reading = named
    .filter((group) => group.reads > 0)
    .map((group) => group.name.toLowerCase());
  const writing = named
    .filter((group) => group.writes > 0)
    .map((group) => group.name.toLowerCase());
  const pair = (names: string[], at: number) => {
    const [first, second] = names.slice(at, at + 2);
    if (first === undefined) {
      return null;
    }
    return second === undefined ? first : words.and(first, second);
  };
  const sentences: (ToolExample | null)[] = [
    reading[0] === undefined
      ? null
      : { sentence: words.exampleRead(pair(reading, 0) ?? ""), writes: false },
    writing[0] === undefined
      ? null
      : { sentence: words.exampleWrite(writing[0]), writes: true },
    reading[2] === undefined
      ? null
      : { sentence: words.exampleRead(pair(reading, 2) ?? ""), writes: false },
    writing[1] === undefined
      ? null
      : { sentence: words.exampleWrite(pair(writing, 1) ?? ""), writes: true },
  ];
  return sentences
    .filter((sentence): sentence is ToolExample => sentence !== null)
    .slice(0, count);
};

/** Whether a tool's name or description holds the words searched for. */
export const matches = (tool: AppTool, query: string) => {
  const needle = query.trim().toLocaleLowerCase();
  return (
    needle === "" ||
    tool.name.toLocaleLowerCase().includes(needle) ||
    (tool.description ?? "").toLocaleLowerCase().includes(needle)
  );
};
