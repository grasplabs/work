// An app's tools made legible: grouped by what they act on (Contacts, Deals, Pipelines…), read from
// their names where the host gives no group; counted, read against change; and a few plain sentences
// of what the app can do, from its largest groups. Words for the sentences are the host's (words.ts).
import type { AppTool, AppToolChoice } from "./model";

/** The verbs a tool's name may start with, before what it acts on ("Batch read", "List", "Append"). */
const VERBS = new Set([
  "add",
  "append",
  "apply",
  "approve",
  "archive",
  "assign",
  "associate",
  "attach",
  "batch",
  "cancel",
  "check",
  "clone",
  "close",
  "complete",
  "convert",
  "copy",
  "count",
  "create",
  "delete",
  "describe",
  "detach",
  "disable",
  "download",
  "duplicate",
  "edit",
  "enable",
  "enroll",
  "execute",
  "export",
  "fetch",
  "find",
  "follow",
  "generate",
  "get",
  "import",
  "insert",
  "invite",
  "join",
  "kick",
  "leave",
  "link",
  "list",
  "lookup",
  "mark",
  "merge",
  "modify",
  "move",
  "open",
  "patch",
  "pause",
  "pin",
  "post",
  "prepend",
  "publish",
  "put",
  "query",
  "react",
  "read",
  "reject",
  "remove",
  "rename",
  "reply",
  "reopen",
  "resolve",
  "restore",
  "resume",
  "retrieve",
  "revoke",
  "run",
  "save",
  "schedule",
  "search",
  "send",
  "sends",
  "set",
  "share",
  "star",
  "start",
  "stop",
  "submit",
  "subscribe",
  "sync",
  "transfer",
  "trigger",
  "unarchive",
  "unassign",
  "unenroll",
  "unfollow",
  "unlink",
  "unpin",
  "unstar",
  "unsubscribe",
  "update",
  "upload",
  "upsert",
  "validate",
  "verify",
  "view",
  "watch",
]);

/** Words that are not what a tool acts on: articles, prepositions, qualifiers. They are skipped. */
const SKIPPED = new Set([
  "a",
  "an",
  "the",
  "all",
  "any",
  "each",
  "every",
  "new",
  "many",
  "multiple",
  "one",
  "single",
  "and",
  "or",
  "of",
  "for",
  "to",
  "from",
  "in",
  "into",
  "on",
  "onto",
  "by",
  "with",
  "without",
  "at",
  "as",
  "via",
  "per",
  "about",
  "my",
  "your",
  "its",
  "their",
  "own",
  "current",
  "default",
  "custom",
  "legacy",
  "bulk",
  "recent",
  "latest",
  "specific",
  "given",
  "existing",
  "authenticated",
  "user's",
  "details",
  "info",
  "using",
  "v1",
  "v2",
  "v3",
  "free",
  "quick",
  "open",
  "active",
  "available",
  "various",
  "other",
  "me",
  "you",
  "us",
  "them",
  "it",
  "him",
  "her",
  "myself",
]);

/** Two words that name one thing, kept together: "Pull requests", not "Pulls". */
const COMPOUNDS = new Map([
  ["pull request", "Pull requests"],
  ["merge request", "Merge requests"],
  ["direct message", "Direct messages"],
  ["access token", "Access tokens"],
]);

/** Short words written as letters (CRM, API): kept as they are, never made plural. */
const ACRONYMS = new Set([
  "ai",
  "api",
  "crm",
  "csv",
  "dm",
  "dns",
  "faq",
  "id",
  "ip",
  "kb",
  "pdf",
  "seo",
  "sms",
  "soql",
  "sql",
  "ssl",
  "url",
  "utm",
]);

/** Nouns whose plural is not made with an s. */
const IRREGULAR = new Map([
  ["child", "children"],
  ["person", "people"],
]);

/** Words with no plural of their own, or whose singular already reads as a group ("Data", "Media"). */
const UNCOUNTED = new Set([
  "children",
  "people",
  "data",
  "metadata",
  "media",
  "analytics",
  "information",
  "content",
  "mail",
  "feedback",
  "inventory",
  "software",
]);

/** A word as a group's name: an acronym as it is, else capitalised and, where it is a noun's singular, made plural. */
const groupName = (word: string, cased: boolean) => {
  const lower = word.toLowerCase();
  if (
    ACRONYMS.has(lower) ||
    (cased &&
      word.length > 1 &&
      word === word.toUpperCase() &&
      /\p{Lu}/u.test(word))
  ) {
    return word.toUpperCase();
  }
  let many = IRREGULAR.get(lower) ?? `${lower}s`;
  // Already plural, or ending in s (Settings, Access), or with no plural: as it is.
  if ((lower.endsWith("s") && !IRREGULAR.has(lower)) || UNCOUNTED.has(lower)) {
    many = lower;
  } else if (/[^aeiou]y$/u.test(lower)) {
    many = `${lower.slice(0, -1)}ies`;
  } else if (/(?:x|ch|sh)$/u.test(lower)) {
    many = `${lower}es`;
  }
  return many.charAt(0).toUpperCase() + many.slice(1);
};

/** Whether a word can name what a tool acts on: letters, not a verb's form (scheduled, pending), not a skipped word. */
const nounLike = (word: string) => {
  const lower = word.toLowerCase();
  return (
    /^\p{L}[\p{L}']*$/u.test(word) &&
    lower.length > 1 &&
    !VERBS.has(lower) &&
    !SKIPPED.has(lower) &&
    !/(?:ed|ing)$/u.test(lower)
  );
};

/** A verb, or as a name's first word in the third person ("Schedules", "Fetches", "Replies"). */
const verbAt = (word: string, at: number) => {
  const lower = word.toLowerCase();
  return (
    VERBS.has(lower) ||
    (at === 0 &&
      [
        lower.replace(/s$/u, ""),
        lower.replace(/es$/u, ""),
        lower.replace(/ies$/u, "y"),
      ].some((stem) => stem !== lower && VERBS.has(stem)))
  );
};

/** The app's own name in a tool's id ("HUBSPOT_LIST_CONTACTS" → "hubspot"), skipped where its name repeats it. */
const appOf = (tool: AppTool) => {
  const [prefix] = tool.id.split("_");
  return prefix === undefined || prefix === tool.id ? "" : prefix.toLowerCase();
};

/**
 * What a tool acts on, from its name: after its verbs, the app's own name and the words that only
 * qualify, the first noun ("Batch read companies" → "Companies", "HubSpot create CRM object" → "CRM").
 * Where no word can name it, null: the tool goes to Other, rather than to an invented word.
 */
export const groupOf = (tool: AppTool) => {
  if (tool.group !== undefined && tool.group !== "") {
    return tool.group;
  }
  const app = appOf(tool);
  const words = tool.name
    .split(/[\s_/-]+/u)
    .filter((word) => word !== "" && word.toLowerCase() !== app);
  // Past the verbs and the words that only qualify at its start: then the first word that can name it.
  const start = words.findIndex(
    (word, index) => !verbAt(word, index) && !SKIPPED.has(word.toLowerCase())
  );
  const rest = start === -1 ? [] : words.slice(start);
  const at = rest.findIndex(
    (word) => nounLike(word) || ACRONYMS.has(word.toLowerCase())
  );
  const object = rest[at];
  if (object === undefined) {
    return null;
  }
  // A name written all in capitals (a raw slug) says nothing by its case.
  const cased = /\p{Ll}/u.test(tool.name);
  const next = rest[at + 1];
  const pair =
    next === undefined
      ? ""
      : `${object} ${next.replace(/s$/u, "")}`.toLowerCase();
  if (COMPOUNDS.has(pair)) {
    return COMPOUNDS.get(pair) ?? null;
  }
  // A singular noun before a plural one only says which kind ("team channels"): the plural names it.
  if (
    next !== undefined &&
    nounLike(next) &&
    next.toLowerCase().endsWith("s") &&
    !object.toLowerCase().endsWith("s") &&
    !ACRONYMS.has(object.toLowerCase())
  ) {
    return groupName(next, cased);
  }
  return groupName(object, cased);
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
