import { toolClassOf } from "@grasp-os/shared/connect";
import type {
  ConnectionScope,
  ToolClass,
  ToolReach,
} from "@grasp-os/shared/connect";
import { isRecord } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { connectionTools } from "./db/schema.ts";
import { isNeverTool, wordsOf } from "./never.ts";
import { isShallowJson } from "./served-schemas.ts";

// The class of a tool an MCP server lists, by fixed rules: the same for
// every server, with no model and no person deciding tool by tool, and
// computed from the tool as the server lists it now, never stored. A tool
// the server changes is classed again the next time its list is read.
//
// Everything the server says is untrusted (threat model on GRA-1375), so
// every doubt falls on the side of a change, which is held for its person:
// a read held by mistake is a nuisance, a change let through is a risk.
// - A tool is a read only when everything agrees: its name starts with a
//   verb that reads, no word of its name changes anything, its own
//   annotations don't say it changes anything, and it takes no
//   recipients. A server's hints only ever make a tool a change.
// - It reaches others when its input names people to reach (emails,
//   recipients, attendees, a message), whatever it declares; it reaches
//   conversations when its name reads or writes what people said
//   (messages, chats, transcripts). Anything else reaches what its
//   connection holds: the person's own, or the company's.
// - Its description is never read: it is the vendor's text, written for
//   the model, and may be written to steer it.
// - What Grasp never does (never.ts) is refused by name, as for every tool.

/** The words a read's name starts with. */
const readVerbs: ReadonlySet<string> = new Set([
  "get",
  "list",
  "search",
  "read",
  "find",
]);

/**
 * Verbs that make a name one of a change wherever they stand in it, and
 * the words that join a second verb to the first (`get_or_create`,
 * `findAndUpdate`). Only words that are verbs whatever follows them: a
 * noun that is also a verb (`comment`, `post`, `run`) would make
 * `get_comment` a change.
 */
const changeWords: ReadonlySet<string> = new Set([
  "add",
  "and",
  "approve",
  "archive",
  "assign",
  "cancel",
  "create",
  "edit",
  "execute",
  "insert",
  "invite",
  "modify",
  "or",
  "publish",
  "save",
  "send",
  "submit",
  "then",
  "update",
  "upload",
  "upsert",
  "write",
]);

/** Input property words that name people a call reaches. */
const recipientWords: ReadonlySet<string> = new Set([
  "attendee",
  "attendees",
  "bcc",
  "cc",
  "email",
  "emails",
  "guest",
  "guests",
  "invitee",
  "invitees",
  "message",
  "messages",
  "recipient",
  "recipients",
]);

/**
 * Input property names that name people a call reaches only as a whole
 * name at the input's top: `to` is a recipient, while `relatedTo`
 * relates an issue and a nested `{ from, to }` moves text.
 */
const recipientNames: ReadonlySet<string> = new Set(["to"]);

/** Name words for what other people said where the person was. */
const conversationWords: ReadonlySet<string> = new Set([
  "chat",
  "chats",
  "conversation",
  "conversations",
  "dm",
  "dms",
  "email",
  "emails",
  "inbox",
  "mail",
  "mails",
  "message",
  "messages",
  "transcript",
  "transcripts",
]);

/** Whether `value` is a JSON array (`Array.isArray` says only `any[]`). */
export const isJsonArray = (
  value: Json | undefined
): value is readonly Json[] => Array.isArray(value);

/**
 * The annotations a server lists with a tool, as far as the rules read
 * them: only a word that says it changes something counts.
 */
export interface ToolHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/** A tool as the rules read it: its name, input schema and hints. */
export interface RuledTool {
  name: string;
  inputSchema: Json;
  annotations: ToolHints;
}

/**
 * Every property name `schema` declares, nested ones too: in
 * `properties`, and through `items`, `additionalProperties` and the
 * composition keywords. Walked with a stack of its own; the schema was
 * checked for depth and size when its list was read.
 */
const propertyNames = (schema: Json): string[] => {
  const names: string[] = [];
  const pending: Json[] = [schema];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (!isRecord(next)) {
      continue;
    }
    const { properties, items, additionalProperties, anyOf, oneOf, allOf } =
      next;
    if (isRecord(properties)) {
      for (const [name, property] of Object.entries(properties)) {
        names.push(name);
        if (property !== undefined) {
          pending.push(property);
        }
      }
    }
    for (const nested of [items, additionalProperties]) {
      if (nested !== undefined) {
        pending.push(nested);
      }
    }
    for (const members of [anyOf, oneOf, allOf]) {
      if (isJsonArray(members)) {
        for (const member of members) {
          pending.push(member);
        }
      }
    }
  }
  return names;
};

/**
 * The names of the input's own properties: at its top, and at the top of
 * every schema it is composed of (`anyOf`, `oneOf`, `allOf`).
 */
const topNames = (schema: Json): string[] => {
  const names: string[] = [];
  const pending: Json[] = [schema];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (!isRecord(next)) {
      continue;
    }
    if (isRecord(next.properties)) {
      names.push(...Object.keys(next.properties));
    }
    for (const members of [next.anyOf, next.oneOf, next.allOf]) {
      if (isJsonArray(members)) {
        pending.push(...members);
      }
    }
  }
  return names;
};

/** Whether the tool's input names people a call of it reaches. */
const takesRecipients = (inputSchema: Json): boolean =>
  topNames(inputSchema).some((name) =>
    recipientNames.has(name.toLowerCase())
  ) ||
  propertyNames(inputSchema).some((name) =>
    wordsOf(name).some((word) => recipientWords.has(word))
  );

/** Whether the tool only reads, by every sign the rules take. */
const onlyReads = (
  words: readonly string[],
  { readOnlyHint, destructiveHint }: ToolHints,
  recipients: boolean
): boolean =>
  readVerbs.has(words[0] ?? "") &&
  !words.some((word) => changeWords.has(word)) &&
  readOnlyHint !== false &&
  destructiveHint !== true &&
  !recipients;

/**
 * The class of `tool` on a connection of `scope`, by the rules above:
 * `never` for one Grasp never runs.
 */
export const classByRules = (
  { name, inputSchema, annotations }: RuledTool,
  scope: ConnectionScope
): ToolClass => {
  if (isNeverTool(name)) {
    return "never";
  }
  const words = wordsOf(name);
  const recipients = takesRecipients(inputSchema);
  let reach: ToolReach = scope === "personal" ? "own" : "company";
  if (recipients) {
    reach = "others";
  } else if (words.some((word) => conversationWords.has(word))) {
    reach = "conversations";
  }
  return toolClassOf({
    readOnly: onlyReads(words, annotations, recipients),
    reach,
  });
};

/**
 * A schema connect kept as JSON text (`connection_tools`), after it
 * checked it when its list was read: as it was, or no properties at all
 * should the row have been changed at rest.
 */
export const storedSchema = (text: string): Json => {
  const value: unknown = JSON.parse(text);
  return isShallowJson(value) ? value : {};
};

/**
 * The class of each of `tools` by the rules, by name, for a connection of
 * `scope`; tools Grasp never runs are left out. Built as own properties
 * whatever a name is (`__proto__` too).
 */
export const classesOf = (
  tools: readonly RuledTool[],
  scope: ConnectionScope
): Record<string, Exclude<ToolClass, "never">> =>
  Object.fromEntries(
    tools.flatMap((tool) => {
      const toolClass = classByRules(tool, scope);
      return toolClass === "never" ? [] : [[tool.name, toolClass]];
    })
  );

/**
 * The class of each tool kept for each of `rows`, connections to
 * connectors, by the rules, as their lists were last read: nothing is
 * asked of a server here. Tools Grasp never runs are left out.
 */
export const keptToolClasses = async (
  db: D1Database,
  rows: readonly { id: string; scope: ConnectionScope }[]
): Promise<Map<string, Record<string, Exclude<ToolClass, "never">>>> => {
  if (rows.length === 0) {
    return new Map();
  }
  const kept = await drizzle(db)
    .select()
    .from(connectionTools)
    .where(
      inArray(
        connectionTools.connectionId,
        rows.map(({ id }) => id)
      )
    );
  return new Map(
    rows.map(({ id, scope }) => [
      id,
      classesOf(
        kept
          .filter(({ connectionId }) => connectionId === id)
          .map((row) => ({
            name: row.name,
            inputSchema: storedSchema(row.inputSchema),
            annotations: row.annotations,
          })),
        scope
      ),
    ])
  );
};
