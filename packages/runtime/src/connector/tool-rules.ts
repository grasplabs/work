import { toolClassOf } from "@grasp-os/shared/connect";
import type {
  ConnectionScope,
  ToolClass,
  ToolReach,
} from "@grasp-os/shared/connect";
import { isRecord } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";

// The rules that class a tool by what it is: its name and its input's
// property names. The same rules class every tool an MCP server lists
// (connect's tool-rules.ts) and check every tool a connector declares
// (`declarationProblem`, run by the manifest's schema at build and at
// load), so a declaration never claims less than the rules find.
//
// Everything a tool says of itself is untrusted (threat models on GRA-1375
// and GRA-2306), so every doubt falls on the side of change: a read held by
// mistake is a nuisance, a change let through is a risk.
// - A tool is a read only on positive evidence. A server's tool: its name
//   leads with a verb that reads (after at most one word, such as the
//   server's own name) and holds no verb that changes anything, its hints
//   don't say it changes anything, and its input names no recipients. A
//   declared tool: it sends only GETs and HEADs, which egress holds it to,
//   and its name holds no verb that changes anything.
// - A server's tool whose name holds no verb the rules know is a change
//   they can't place: it reaches others, the class that is off until an
//   admin turns it on (GRA-2345).
// - It reaches others when its input names people it reaches: recipients,
//   whatever it does; and for a change, also the people and places it acts
//   on (a channel, an assignee, a URL it calls), and whoever a change named
//   for delivering (send, notify, reply) reaches. A draft reaches nobody
//   until someone sends it. It reaches conversations when its name reads
//   or writes what people said. Anything else reaches what its connection
//   holds: the person's own, or the company's.
// - Its description is never read: it is the vendor's text, written for
//   the model, and may be written to steer it.
// - What Grasp never does is refused by name, for every tool (GRA-717),
//   and so is a declared tool that sends a DELETE.
//
// The rules bind a tool's name and schema, not what its server does: a
// hostile server can implement `get_weather` as a write. Its token reaches
// only that vendor, and adding a server is an admin's audited decision.

/**
 * Verbs that read: a server's tool is a read only if its name leads with
 * one, or holds one as its second word (`vendor_list_items`).
 */
const readVerbs: ReadonlySet<string> = new Set([
  "fetch",
  "find",
  "get",
  "list",
  "read",
  "search",
]);

/**
 * Verbs that change something, wherever they stand in a name, and the
 * words that join a second verb to the first (`get_or_create`,
 * `findAndUpdate`). A noun that is also a verb and names what is read
 * (`comment`, `post`, `run`, `label`, `schedule`) isn't one: it
 * would make `get_comment` a change. Both lists err towards change: a
 * name with a verb from each is a change. A word that is one of them
 * after `un`, `de`, `re` or `dis` is one too (`unhide`, `deregister`,
 * `resend`).
 */
const changeWords: ReadonlySet<string> = new Set([
  "accept",
  "ack",
  "acknowledge",
  "activate",
  "add",
  "allow",
  "and",
  "append",
  "apply",
  "approve",
  "archive",
  "assign",
  "attach",
  "authorize",
  "ban",
  "block",
  "book",
  "broadcast",
  "bump",
  "call",
  "cancel",
  "capture",
  "change",
  "checkout",
  "claim",
  "clean",
  "clear",
  "clone",
  "close",
  "commit",
  "complete",
  "confirm",
  "connect",
  "convert",
  "copy",
  "create",
  "deactivate",
  "decline",
  "decrement",
  "dequeue",
  "deliver",
  "deny",
  "deploy",
  "detach",
  "disable",
  "discard",
  "disconnect",
  "dismiss",
  "dispatch",
  "downvote",
  "duplicate",
  "edit",
  "emit",
  "empty",
  "enable",
  "enqueue",
  "enroll",
  "escalate",
  "exec",
  "execute",
  "export",
  "extend",
  "favorite",
  "fill",
  "fire",
  "flush",
  "follow",
  "fulfill",
  "hide",
  "import",
  "increment",
  "insert",
  "install",
  "invoke",
  "join",
  "kick",
  "kill",
  "launch",
  "leave",
  "like",
  "link",
  "lock",
  "login",
  "logout",
  "make",
  "mark",
  "merge",
  "migrate",
  "modify",
  "move",
  "mute",
  "notify",
  "or",
  "overwrite",
  "patch",
  "pause",
  "perform",
  "pin",
  "place",
  "provision",
  "prune",
  "publish",
  "push",
  "put",
  "react",
  "reassign",
  "reboot",
  "rebuild",
  "redeem",
  "refresh",
  "regenerate",
  "register",
  "reindex",
  "reject",
  "reload",
  "rename",
  "renew",
  "reopen",
  "reorder",
  "replace",
  "replay",
  "reply",
  "request",
  "rerun",
  "reschedule",
  "reserve",
  "reset",
  "resolve",
  "respond",
  "restart",
  "restore",
  "resume",
  "retry",
  "revert",
  "rollback",
  "rotate",
  "save",
  "scale",
  "send",
  "set",
  "ship",
  "shutdown",
  "snooze",
  "sort",
  "split",
  "star",
  "start",
  "stop",
  "submit",
  "subscribe",
  "suspend",
  "swap",
  "sync",
  "then",
  "toggle",
  "transition",
  "trigger",
  "unarchive",
  "unassign",
  "unblock",
  "undo",
  "unfollow",
  "unlink",
  "unlock",
  "unmute",
  "unpin",
  "unstar",
  "unsubscribe",
  "update",
  "upgrade",
  "upload",
  "upsert",
  "upvote",
  "void",
  "vote",
  "write",
]);

/**
 * Input property words that name people a call reaches, whatever it does:
 * a read that takes them may tell them (a read receipt, an invitation), or
 * send what it read to an address it is given (a callback).
 */
const recipientWords: ReadonlySet<string> = new Set([
  "attendee",
  "attendees",
  "bcc",
  "callback",
  "callbacks",
  "cc",
  "email",
  "emails",
  "guest",
  "guests",
  "invitee",
  "invitees",
  "recipient",
  "recipients",
  "webhook",
  "webhooks",
]);

/**
 * Input property words that name the people and places a change acts on:
 * a message posted in a channel, an issue assigned, a URL called. A read
 * that takes them only filters by them.
 */
const targetWords: ReadonlySet<string> = new Set([
  "assignee",
  "assignees",
  "channel",
  "channels",
  "member",
  "members",
  "mention",
  "mentions",
  "participant",
  "participants",
  "phone",
  "phones",
  "sms",
  "url",
  "urls",
  "user",
  "users",
]);

/**
 * Name words that send something to people: a change named with one
 * reaches others, and a draft named with one is sent, not written.
 */
const sendingWords: ReadonlySet<string> = new Set([
  "broadcast",
  "deliver",
  "dispatch",
  "notify",
  "post",
  "publish",
  "send",
  "submit",
]);

/**
 * Name words that deliver to people, as a change: the sending words, and
 * answering (`reply_to_thread`), which a draft may name as what it holds
 * (`create_reply_draft`).
 */
const deliveryWords: ReadonlySet<string> = new Set([
  ...sendingWords,
  "reply",
  "respond",
]);

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

/**
 * What Grasp never does, as parts of words: a name holding one anywhere,
 * in any case and however its words are joined (`deletion`, `softDelete`,
 * `HTTPDelete`, `bulk_unshare`), is refused. Deleting; permissions and
 * sharing; forwarding, mail rules and hooks that send data out; settings;
 * payments. It errs towards refusing: a read named for one of them
 * (`list_mail_rules`) is refused too, and that costs less than a change
 * let through. `access` and `owner` aren't one: they name reading as
 * often as granting (an access token, the resources one can access, a
 * CRM's owners), and granting is caught by `grant`, `share`,
 * `permission`, `role`, `invit` and `transfer`.
 */
const neverParts: readonly string[] = [
  // Deleting
  "delet",
  "destroy",
  "purg",
  "remov",
  "trash",
  "truncat",
  "wipe",
  // Permissions and sharing
  "collaborat",
  "invit",
  "permission",
  "revoc",
  "revok",
  "unshar",
  // Forwarding, mail rules and hooks
  "autorepl",
  "filter",
  "forward",
  "redirect",
  "webhook",
  // Settings
  "config",
  "preference",
  "setting",
  // Payments
  "invoice",
  "purchas",
  "refund",
  "subscription",
  "transfer",
  "withdraw",
];

/**
 * What Grasp never does, as the start of a word: words too short to find
 * inside others (`acl` in `oracle`, `grant` in `migrant`) are matched
 * where a word starts, so `dropTable`, `getACLs`, `shared` and
 * `payment` are refused.
 */
const neverStarts: readonly string[] = [
  "acl",
  "charge",
  "drop",
  "eras",
  "grant",
  "paid",
  "pay",
  "role",
  "rule",
  "share",
];

/** A JSON Schema `format` whose value is a date, a time or a span. */
const timeFormats: ReadonlySet<string> = new Set([
  "date",
  "date-time",
  "duration",
  "time",
]);

/** A name in plain printable ASCII, which the rules can read by words. */
const plainName = /^[ -~]*$/u;

/** The prefixes that undo or repeat a change: `unhide`, `deregister`. */
const changePrefixes: readonly string[] = ["dis", "de", "re", "un"];

/**
 * A name's words, lowercase: split at anything not a letter or digit, at
 * camelCase, and at the end of an acronym (`HTTPDelete`), keeping an
 * acronym's plural whole (`getACLs`, `URLs`).
 */
const wordsOf = (name: string): string[] =>
  name
    .replaceAll(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, "$<lower> $<upper>")
    .replaceAll(
      /(?<run>[A-Z])(?<word>[A-Z](?!s(?![a-z]))[a-z])/gu,
      "$<run> $<word>"
    )
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word !== "");

/**
 * Whether the tool `name` is one Grasp never runs. A name outside plain
 * ASCII can't be read (`dеlete` with a Cyrillic е), so it is one.
 */
export const isNeverTool = (name: string): boolean => {
  const joined = name.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
  return (
    !plainName.test(name) ||
    neverParts.some((part) => joined.includes(part)) ||
    wordsOf(name).some((word) =>
      neverStarts.some((start) => word.startsWith(start))
    )
  );
};

/** Whether `word` is a change word, or one after a prefix that undoes it. */
const isChangeWord = (word: string): boolean =>
  changeWords.has(word) ||
  changePrefixes.some(
    (prefix) =>
      word.startsWith(prefix) && changeWords.has(word.slice(prefix.length))
  );

/** A property's name and its schema, as a schema's `properties` hold it. */
type Property = [name: string, schema: Json | undefined];

/** Whether `value` is a JSON array (`Array.isArray` says only `any[]`). */
export const isJsonArray = (
  value: Json | undefined
): value is readonly Json[] => Array.isArray(value);

/**
 * Every property `schema` declares, at any depth and under any keyword
 * (`$defs` and tuples too), with its schema: the entries of every
 * `properties` object in it. Reading too many only ever makes a tool
 * count as reaching others. Walked with a stack of its own; a server's
 * schema was checked for depth and size when its list was read.
 */
const allProperties = (schema: Json): Property[] => {
  const found: Property[] = [];
  const pending: Json[] = [schema];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (isJsonArray(next)) {
      pending.push(...next);
    } else if (isRecord(next)) {
      if (isRecord(next.properties)) {
        found.push(...Object.entries(next.properties));
      }
      for (const value of Object.values(next)) {
        if (value !== undefined) {
          pending.push(value);
        }
      }
    }
  }
  return found;
};

/** A reference to one of the root's own definitions (`#/$defs/x`). */
const localDefinitionPattern =
  /^#\/(?<keyword>\$defs|definitions)\/(?<name>[^/]+)$/u;

/**
 * The input's own properties, with their schemas: at its top, at the top
 * of every schema it is composed of (`anyOf`, `oneOf`, `allOf`), and at
 * the top of the root's definition a `$ref` there names (JSON Pointer,
 * RFC 6901).
 */
const topProperties = (schema: Json): Property[] => {
  const found: Property[] = [];
  const pending: Json[] = [schema];
  const followed = new Set<string>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (!isRecord(next)) {
      continue;
    }
    if (isRecord(next.properties)) {
      found.push(...Object.entries(next.properties));
    }
    for (const members of [next.anyOf, next.oneOf, next.allOf]) {
      if (isJsonArray(members)) {
        pending.push(...members);
      }
    }
    const ref =
      typeof next.$ref === "string"
        ? localDefinitionPattern.exec(next.$ref)?.groups
        : undefined;
    const definitions =
      ref?.keyword === undefined || !isRecord(schema)
        ? undefined
        : schema[ref.keyword];
    const name = ref?.name?.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      name !== undefined &&
      isRecord(definitions) &&
      Object.hasOwn(definitions, name) &&
      !followed.has(name)
    ) {
      followed.add(name);
      const definition = definitions[name];
      if (definition !== undefined) {
        pending.push(definition);
      }
    }
  }
  return found;
};

/** The names of the input's own properties (`topProperties`). */
export const topNames = (schema: Json): string[] =>
  topProperties(schema).map(([name]) => name);

/**
 * Whether a property's value can name nobody: its schema says it is a
 * date or a time, or a flag. Anything else may hold an address or an ID,
 * numbers too (a chat's, a user's).
 */
const namesNobody = (schema: Json | undefined): boolean =>
  isRecord(schema) &&
  ((typeof schema.format === "string" && timeFormats.has(schema.format)) ||
    schema.type === "boolean");

/**
 * Whether a property names people by its words: one of `words`, or, at
 * the input's top, `to` as its first or last word (`to`, `sendTo`,
 * `toAddress`); a nested `{ from, to }` is a range, of times or of text.
 * A name outside plain ASCII can't be read by words (`rеcipients` with a
 * Cyrillic е), so it counts as naming people.
 */
const namesPeople = (
  [name, schema]: Property,
  words: ReadonlySet<string>,
  top: boolean
): boolean => {
  if (!plainName.test(name)) {
    return true;
  }
  if (namesNobody(schema)) {
    return false;
  }
  const nameWords = wordsOf(name);
  return (
    nameWords.some((word) => words.has(word)) ||
    (top && (nameWords[0] === "to" || nameWords.at(-1) === "to"))
  );
};

/** What the rules find in a tool's name and input schema. */
interface Findings {
  /** Its name leads with a verb that reads. */
  reads: boolean;
  /** Its name holds a verb that changes something. */
  changes: boolean;
  /** Its input names people it reaches, whatever it does. */
  recipients: boolean;
  /** Its input names people or places a change of it acts on, or its name delivers to people. */
  targets: boolean;
  /** Its name reads or writes what people said. */
  conversations: boolean;
}

/** What the rules find in the tool `name` taking `inputSchema`. */
const findingsOf = (name: string, inputSchema: Json): Findings => {
  const words = wordsOf(name);
  // A draft is written for its person to send: whoever it names is
  // reached only by the send, which is a tool of its own.
  const draft =
    words.some((word) => word === "draft" || word === "drafts") &&
    !words.some((word) => sendingWords.has(word));
  const top = topProperties(inputSchema);
  const all = allProperties(inputSchema);
  const names = (each: ReadonlySet<string>) =>
    !draft &&
    (top.some((property) => namesPeople(property, each, true)) ||
      all.some((property) => namesPeople(property, each, false)));
  return {
    reads: words.slice(0, 2).some((word) => readVerbs.has(word)),
    changes: words.some(isChangeWord),
    recipients: names(recipientWords),
    targets:
      names(targetWords) ||
      (!draft && words.some((word) => deliveryWords.has(word))),
    conversations: words.some((word) => conversationWords.has(word)),
  };
};

/** Whom a tool reaches by `found`, where it otherwise reaches `usual`. */
const reachOf = (
  found: Findings,
  readOnly: boolean,
  usual: ToolReach
): ToolReach => {
  if (found.recipients || (!readOnly && found.targets)) {
    return "others";
  }
  return found.conversations ? "conversations" : usual;
};

/**
 * The annotations a server lists with a tool, as far as the rules read
 * them: only a word that says it changes something counts.
 */
export interface ToolHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/** A server's tool as the rules read it: its name, input schema and hints. */
export interface RuledTool {
  name: string;
  inputSchema: Json;
  annotations: ToolHints;
}

/**
 * The class of a server's `tool` on a connection of `scope`, by the
 * rules above: `never` for one Grasp never runs.
 */
export const classByRules = (
  { name, inputSchema, annotations }: RuledTool,
  scope: ConnectionScope
): ToolClass => {
  if (isNeverTool(name)) {
    return "never";
  }
  const found = findingsOf(name, inputSchema);
  const changes =
    found.changes ||
    annotations.readOnlyHint === false ||
    annotations.destructiveHint === true;
  if (!found.reads && !found.changes) {
    return "reach-others";
  }
  const readOnly = found.reads && !changes && !found.recipients;
  return toolClassOf({
    readOnly,
    reach: reachOf(found, readOnly, scope === "personal" ? "own" : "company"),
  });
};

/** The methods a read sends. */
const readMethods: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/** A tool as its connector declares it, as far as the rules check it. */
export interface DeclaredTool {
  readOnly: boolean;
  reach: ToolReach;
  routes: readonly { method: string }[];
  contract: { input: Json };
}

/**
 * Why the declaration of tool `name` claims less than the rules find, if
 * it does: it is one Grasp never runs, by its name or because it sends a
 * DELETE, whatever it is called; it claims to read but sends a
 * request other than a GET or HEAD, or is named for a change; or its
 * input names people it reaches but it doesn't say it reaches others.
 * Whether what it reads is the person's own or others' conversations is
 * the declaration's to say: the rules only guess it from a name word.
 */
export const declarationProblem = (
  name: string,
  { readOnly, reach, routes, contract }: DeclaredTool
): string | undefined => {
  if (isNeverTool(name) || routes.some(({ method }) => method === "DELETE")) {
    return "Grasp never runs it";
  }
  const found = findingsOf(name, contract.input);
  if (readOnly && routes.some(({ method }) => !readMethods.has(method))) {
    return "it is read-only, so it sends only GET and HEAD requests";
  }
  if (readOnly && found.changes) {
    return "it is read-only, but its name says it changes something";
  }
  if (reach !== "others" && reachOf(found, readOnly, reach) === "others") {
    return "its input names people or places it reaches, so it reaches others";
  }
  return undefined;
};
