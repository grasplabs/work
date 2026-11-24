// An app's tools made legible: grouped by what they act on (Contacts, Deals, Pipelines…), read from
// their names where the host gives no group; counted, read against change.
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

/**
 * Verbs that are nouns as well: a verb as a name's first word ("Post message", "Reply to thread"),
 * the thing acted on after another verb ("Create link", "Get post comments").
 */
const NOUNS_TOO = new Set([
  "link",
  "reply",
  "post",
  "share",
  "view",
  "query",
  "export",
  "import",
  "run",
  "check",
  "copy",
]);

/** Words in -ing that name a thing that can be counted ("Meetings"); others are mass nouns ("Billing"). */
const COUNTED_ING = new Set([
  "meeting",
  "recording",
  "booking",
  "listing",
  "setting",
  "posting",
  "warning",
  "mapping",
  "rating",
  "heading",
  "finding",
  "building",
  "drawing",
  "opening",
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
  "pending",
  "upcoming",
  "incoming",
  "outgoing",
  "missing",
  "remaining",
  "trending",
  "related",
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

/**
 * A word as a group's name: an acronym as it is, a name of its own (OneNote, or Excel written with a
 * capital inside a sentence) as it is, else capitalised and, where it is a noun's singular, made plural.
 */
const groupName = (word: string, cased: boolean, first: boolean) => {
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
  if (
    cased &&
    (/\p{Ll}\p{Lu}/u.test(word) || (!first && /^\p{Lu}/u.test(word)))
  ) {
    return word;
  }
  let many = IRREGULAR.get(lower) ?? `${lower}s`;
  // Already plural, or ending in s (Settings, Access), or with no plural: as it is.
  if (
    (lower.endsWith("s") && !IRREGULAR.has(lower)) ||
    UNCOUNTED.has(lower) ||
    (lower.endsWith("ing") && !COUNTED_ING.has(lower))
  ) {
    many = lower;
  } else if (/[^aeiou]y$/u.test(lower)) {
    many = `${lower.slice(0, -1)}ies`;
  } else if (/(?:x|ch|sh)$/u.test(lower)) {
    many = `${lower}es`;
  }
  return many.charAt(0).toUpperCase() + many.slice(1);
};

/** A known verb in -ed or -ing ("scheduled", "archived", "pinned", "running"): it only qualifies. */
const verbForm = (lower: string) => {
  const stem = /^(?<stem>.+?)(?:ed|ing)$/u.exec(lower)?.groups?.stem;
  if (stem === undefined) {
    return false;
  }
  const undoubled = /(?<last>[^aeiou])\k<last>$/u.test(stem)
    ? stem.slice(0, -1)
    : stem;
  return [stem, `${stem}e`, undoubled, lower.replace(/d$/u, "")].some((form) =>
    VERBS.has(form)
  );
};

/** Whether a word can name what a tool acts on: letters, not a verb or a verb's form (scheduled), not a skipped word. */
const nounLike = (word: string) => {
  const lower = word.toLowerCase();
  return (
    /^\p{L}[\p{L}']*$/u.test(word) &&
    lower.length > 1 &&
    (!VERBS.has(lower) || NOUNS_TOO.has(lower)) &&
    !SKIPPED.has(lower) &&
    !verbForm(lower)
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
 * The part of a suite a tool's id names before its dot ("excel.listRows" → "excel"): a product (Excel,
 * To Do) or the suite's own area (Mail, Lists), so its name is never made plural. It reads as the
 * tool's name writes it ("Todo lists" → "Todo"), else as the id writes it, capitalised.
 */
const partOf = (tool: AppTool) =>
  /^(?<area>[^.\s]+)\./u.exec(tool.id)?.groups?.area;

const areaOf = (tool: AppTool) => {
  const area = partOf(tool);
  if (area === undefined) {
    return null;
  }
  const words = tool.name.split(/\s+/u);
  let joined = "";
  for (const [index, word] of words.entries()) {
    joined += word.toLowerCase();
    if (joined === area.toLowerCase()) {
      return words.slice(0, index + 1).join(" ");
    }
    if (!area.toLowerCase().startsWith(joined)) {
      break;
    }
  }
  return area.charAt(0).toUpperCase() + area.slice(1);
};

/**
 * What a tool acts on, from its name: after its verbs, the app's own name and the words that only
 * qualify, the first noun ("Batch read companies" → "Companies", "HubSpot create CRM object" → "CRM").
 * Where no word can name it, null: the tool goes to Other, rather than to an invented word.
 */
const readGroup = (tool: AppTool) => {
  const area = areaOf(tool);
  if (area !== null) {
    return area;
  }
  const app = appOf(tool);
  const words = tool.name
    .split(/[\s_/-]+/u)
    .filter((word) => word !== "" && word.toLowerCase() !== app);
  // Past the verbs and the words that only qualify at its start: then the first word that can name it.
  // A verb that is a noun as well names the thing once a verb has come before it ("Create link").
  const start = words.findIndex(
    (word, index) =>
      (!verbAt(word, index) ||
        (index > 0 && NOUNS_TOO.has(word.toLowerCase()))) &&
      !SKIPPED.has(word.toLowerCase())
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
    return groupName(next, cased, false);
  }
  return groupName(object, cased, words.indexOf(object) === 0);
};

/**
 * A group's key, the same in every language, for the host to name the group by: the suite part
 * before the id's dot ("todo"), else what the tool's name says it acts on, in lower case
 * ("contacts", "pull requests"); null where nothing names it (Other).
 */
export const groupKeyOf = (tool: AppTool) =>
  partOf(tool)?.toLowerCase() ?? readGroup(tool)?.toLowerCase() ?? null;

/** The host's name for a group, in the page's language, by its key; undefined where it has none. */
export type ToolGroupNamer = (key: string) => string | undefined;

/**
 * A tool's group, as the page shows it: the tool's own `group`, else the host's name for its key,
 * else the name read from its id or name. Words read from an English name are only the fallback.
 */
export const groupOf = (tool: AppTool, named?: ToolGroupNamer) => {
  if (tool.group !== undefined && tool.group !== "") {
    return tool.group;
  }
  const key = groupKeyOf(tool);
  const hosted = key === null ? undefined : named?.(key);
  return hosted !== undefined && hosted !== "" ? hosted : readGroup(tool);
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
export const groupTools = (
  tools: readonly AppTool[],
  named?: ToolGroupNamer
): ToolGroup[] => {
  const byName = new Map<string, AppTool[]>();
  const loose: AppTool[] = [];
  for (const tool of tools) {
    const name = groupOf(tool, named);
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

/** Whether a tool's name or description holds the words searched for. */
export const matches = (tool: AppTool, query: string) => {
  const needle = query.trim().toLocaleLowerCase();
  return (
    needle === "" ||
    tool.name.toLocaleLowerCase().includes(needle) ||
    (tool.description ?? "").toLocaleLowerCase().includes(needle)
  );
};
