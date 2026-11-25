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
// - What Grasp never does is refused by name, for every tool (GRA-717);
//   a declared tool can't send a DELETE at all (manifest.ts).
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
  "claim",
  "clean",
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
  "disconnect",
  "dismiss",
  "dispatch",
  "downvote",
  "duplicate",
  "edit",
  "emit",
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
 * Input property words, matched where a word starts (`emailAddress`,
 * `recipientlist`), that name people a call reaches whatever it does: a
 * read that takes them may tell them (a read receipt, an invitation).
 */
const recipientWords: readonly string[] = [
  "attendee",
  "bcc",
  "cc",
  "email",
  "guest",
  "invitee",
  "recipient",
];

/**
 * Input property words, matched where a word starts, that name an address
 * the call itself sends to, whatever it does, a draft too: a read that
 * takes a callback sends what it read there.
 */
const addressWords: readonly string[] = ["callback", "webhook"];

/**
 * Input property words, matched where a word starts (`username`), that
 * name the people and places a change acts on: a message posted in a
 * channel, an issue assigned, a URL called, a watcher told. A read that
 * takes them only filters by them.
 */
const targetWords: readonly string[] = [
  "address",
  "assignee",
  "channel",
  "follower",
  "member",
  "mention",
  "participant",
  "phone",
  "receiver",
  "reviewer",
  "sms",
  "subscriber",
  "url",
  "user",
  "watcher",
];

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
 * What an input's property holds where it sends (`sendNow`, `autosend`,
 * `shouldNotify`, `scheduleDate`), found anywhere in its name. Not
 * `post`, which `postalCode` holds. Such a property makes a change reach
 * others; as a flag, it makes any tool reach others, a read too
 * (`fetch_report` taking `sendNow`), while a read that filters by one
 * (`list_deliveries` taking `delivery_status`) stays a read.
 */
const sendingStems: readonly string[] = [
  "broadcast",
  "deliver",
  "dispatch",
  "notif",
  "publish",
  "schedul",
  "send",
  "submit",
];

/**
 * Name words that answer people: a change named with one reaches them,
 * while a draft may name one as what it holds (`create_reply_draft`).
 */
const answeringWords: ReadonlySet<string> = new Set(["reply", "respond"]);

/** The change words that write a draft rather than act on it. */
const writingWords: ReadonlySet<string> = new Set([
  "add",
  "create",
  "edit",
  "make",
  "modify",
  "patch",
  "put",
  "save",
  "set",
  "update",
  "upsert",
  "write",
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
 * `permission`, `role`, `invit` and `transfer`, and by `grantingWords`.
 */
const neverParts: readonly string[] = [
  // Deleting
  "delet",
  "destroy",
  "discard",
  "expung",
  "prune",
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
  "automaticrepl",
  "autorepl",
  "filter",
  "forward",
  "outofoffice",
  "redirect",
  "vacationrespon",
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
 * inside others (`acl` in `oracle`, `eras` in `cameras`) are matched
 * where a word starts, however it goes on, so `dropTable`, `getACLs`,
 * `shared`, `payee` and `sharefile` are refused, but for the few words
 * in `otherWordStarts`.
 */
const neverStarts: readonly string[] = [
  "acl",
  "charge",
  "charging",
  "checkout",
  "clear",
  "drop",
  "empty",
  "eras",
  "grant",
  "hook",
  "paid",
  "pay",
  "reset",
  "role",
  "rule",
  "share",
  "sharing",
  "uninstall",
  "unlink",
  "unset",
];

/**
 * What, after one of `neverStarts`, makes a word another one that names
 * none of it: `sharepoint`, `shareholder`, `payload`, `dropbox`,
 * `dropdown`, `droplet`. Anything else after it is refused.
 */
const otherWordStarts: readonly string[] = [
  "box",
  "down",
  "holder",
  "let",
  "load",
  "point",
];

/**
 * What Grasp never does, as a whole word: words so short they start many
 * others (`del` starts `delay` and `deliver`).
 */
const neverWords: ReadonlySet<string> = new Set([
  "del",
  "dels",
  "rm",
  "rmdir",
  "rmrf",
]);

/**
 * Words for who may reach what: a name with one, led by a word that
 * changes something (its first or second, after a namespace), changes
 * who may reach it (`update_access`, `add_editor`, `make_public`), and
 * is refused. A read of them (`list_owners_and_teams`) isn't.
 */
const grantingWords: ReadonlySet<string> = new Set([
  "access",
  "admin",
  "admins",
  "editor",
  "editors",
  "owner",
  "owners",
  "public",
  "viewer",
  "viewers",
  "visibility",
]);

/**
 * What Grasp never does, as the end of a word, alone or plural: the
 * `neverStarts` a word may be joined after (`userRoles`, `mailrule`,
 * `autopay`, `reshare`, `objectacl`, `githook`).
 */
const neverEnds: readonly string[] = [
  "acl",
  "charge",
  "grant",
  "hook",
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

/** Whether `word` is one of `words`, or one after a prefix (`resend`). */
const isOneOf = (words: ReadonlySet<string>, word: string): boolean =>
  words.has(word) ||
  changePrefixes.some(
    (prefix) => word.startsWith(prefix) && words.has(word.slice(prefix.length))
  );

/**
 * Whether the tool `name` is one Grasp never runs. A name outside plain
 * ASCII can't be read (`dеlete` with a Cyrillic е), so it is one.
 */
export const isNeverTool = (name: string): boolean => {
  const joined = name.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
  const words = wordsOf(name);
  return (
    !plainName.test(name) ||
    neverParts.some((part) => joined.includes(part)) ||
    words.some(
      (word) =>
        neverWords.has(word) ||
        neverStarts.some(
          (start) =>
            word.startsWith(start) &&
            !otherWordStarts.some((other) =>
              word.slice(start.length).startsWith(other)
            )
        ) ||
        neverEnds.some((end) => word.endsWith(end) || word.endsWith(`${end}s`))
    ) ||
    (words.some((word) => grantingWords.has(word)) &&
      words.slice(0, 2).some((word) => isOneOf(changeWords, word)))
  );
};

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
      const { properties } = next;
      if (isRecord(properties)) {
        found.push(...Object.entries(properties));
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

/**
 * What a schema's `$ref` names within `root`, the input's schema: a
 * JSON Pointer in the root's own document (`#/$defs/x`,
 * `#/properties/status`, RFC 6901, percent-decoded as a URI fragment), or
 * undefined for any other, an anchor (`#Flag`) included.
 */
const referenced = (root: Json, ref: Json | undefined): Json | undefined => {
  if (typeof ref !== "string" || !(ref === "#" || ref.startsWith("#/"))) {
    return undefined;
  }
  let tokens: string[];
  try {
    tokens = decodeURIComponent(ref.slice(1)).split("/").slice(1);
  } catch {
    return undefined;
  }
  let at: Json | undefined = root;
  for (const token of tokens) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (isJsonArray(at)) {
      at = /^(?:0|[1-9]\d*)$/u.test(key) ? at[Number(key)] : undefined;
    } else if (isRecord(at) && Object.hasOwn(at, key)) {
      at = at[key];
    } else {
      return undefined;
    }
  }
  return at;
};

/**
 * The names of the input's own properties: at its top, at the top
 * of every schema it is composed of (`anyOf`, `oneOf`, `allOf`), and at
 * the top of the root's definition a `$ref` there names (JSON Pointer,
 * RFC 6901).
 */
export const topNames = (schema: Json): string[] => {
  const found: string[] = [];
  const pending: Json[] = [schema];
  const seen = new Set<Json>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (!isRecord(next) || seen.has(next)) {
      continue;
    }
    seen.add(next);
    if (isRecord(next.properties)) {
      found.push(...Object.keys(next.properties));
    }
    for (const members of [next.anyOf, next.oneOf, next.allOf]) {
      if (isJsonArray(members)) {
        pending.push(...members);
      }
    }
    const definition = referenced(schema, next.$ref);
    if (definition !== undefined) {
      pending.push(definition);
    }
  }
  return found;
};

/**
 * Whether a property's value can name nobody: its schema says it is a
 * string holding a date or a time, or a flag. Anything else may hold an
 * address or an ID, numbers too (a chat's, a user's), whatever its
 * `format` says.
 */
const namesNobody = (schema: Json | undefined): boolean =>
  isRecord(schema) &&
  ((schema.type === "string" &&
    typeof schema.format === "string" &&
    timeFormats.has(schema.format)) ||
    schema.type === "boolean");

/** The values of an `enum` or a `const` that hold a flag, in any case. */
const flagValues: ReadonlySet<Json> = new Set([
  true,
  false,
  null,
  0,
  1,
  "0",
  "1",
  "true",
  "false",
  "yes",
  "no",
  "on",
  "off",
]);

/** Whether `value` is one of `flagValues`. */
const isFlagValue = (value: Json): boolean =>
  flagValues.has(typeof value === "string" ? value.toLowerCase() : value);

/**
 * Whether a schema's own `type`, `enum` and `const` let its value be a
 * flag: its `type` holds `boolean`, or its `enum` or `const` holds only
 * flag values (`"true"`, `"yes"`, `0`), or it says neither.
 */
const holdsFlag = (
  schema: Readonly<Record<string, Json | undefined>>
): boolean => {
  const { type, const: only } = schema;
  const values = schema.enum;
  if (isJsonArray(values) || only !== undefined) {
    return (
      (!isJsonArray(values) || values.every(isFlagValue)) &&
      (only === undefined || isFlagValue(only))
    );
  }
  return (
    type === undefined ||
    type === "boolean" ||
    (isJsonArray(type) && type.includes("boolean"))
  );
};

/**
 * Whether a schema says outright that its value may be a flag: its `type`
 * holds `boolean`, or its `enum` or `const` holds `true`, `false` or a flag
 * word (`"yes"`, `"true"`). A model reads that and sends one, whatever else
 * the schema says. Numbers and `null` don't say it: `[0, 5, 10]` minutes.
 */
const saysFlag = (
  schema: Readonly<Record<string, Json | undefined>>
): boolean => {
  const { type, const: only } = schema;
  const values = schema.enum;
  const said = (value: Json | undefined) =>
    typeof value === "boolean" ||
    (typeof value === "string" && isFlagValue(value));
  return (
    type === "boolean" ||
    (isJsonArray(type) && type.includes("boolean")) ||
    said(only) ||
    (isJsonArray(values) && values.some(said))
  );
};

/**
 * Whether `schema`, or any schema it is made of within the input's `root`
 * (`allOf`, `anyOf`, `oneOf`, a `$ref`'s), says its value may be a flag
 * (`saysFlag`). `clean` holds every schema already read whose own and
 * composed schemas say none, so the properties of one input read each
 * schema once: a read that finds none has read all it is made of.
 */
const mentionsFlag = (
  schema: Json | undefined,
  root: Json,
  clean: Set<Json>
): boolean => {
  const pending: Json[] = schema === undefined ? [] : [schema];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (!isRecord(next) || clean.has(next)) {
      continue;
    }
    if (saysFlag(next)) {
      return true;
    }
    clean.add(next);
    for (const members of [next.anyOf, next.oneOf, next.allOf]) {
      if (isJsonArray(members)) {
        pending.push(...members);
      }
    }
    const named = referenced(root, next.$ref);
    if (named !== undefined) {
      pending.push(named);
    }
  }
  return false;
};

/**
 * How deep `mayBeFlag` reads a schema, `$ref`s followed: they chain past
 * the depth a listed schema may nest, and the stack is finite.
 */
const maxFlagDepth = 64;

/**
 * Whether a property's `schema`, within the input's `root`, lets its value
 * be a flag: every constraint it has allows one. Its own allow one
 * (`holdsFlag`); every member of its `allOf` and some of its `anyOf` or
 * `oneOf` allows one; and what its `$ref` names does. Text and numbers it
 * types (`delivery_status`, an enum of states) aren't flags. A schema with
 * none of them may hold anything, and so may a `$ref` that names nothing
 * in the root, one still being read (a loop) and one past `maxFlagDepth`:
 * each answer only ever raises a class. `known` holds each schema's
 * answer, so one named many times, by any spelling of its `$ref`, is read
 * once.
 */
const mayBeFlag = (
  schema: Json | undefined,
  root: Json,
  known: Map<Json, boolean>,
  depth = 0
): boolean => {
  if (!isRecord(schema) || depth > maxFlagDepth) {
    return true;
  }
  const answer = known.get(schema);
  if (answer !== undefined) {
    return answer;
  }
  known.set(schema, true);
  const allows = (each: Json) => mayBeFlag(each, root, known, depth + 1);
  const { allOf, anyOf, oneOf, $ref } = schema;
  const union = [anyOf, oneOf].filter(isJsonArray).flat();
  const named = referenced(root, $ref);
  const result =
    holdsFlag(schema) &&
    (!isJsonArray(allOf) || allOf.every(allows)) &&
    (union.length === 0 || union.some(allows)) &&
    (named === undefined || allows(named));
  known.set(schema, result);
  return result;
};

/**
 * Whether a property names people by its words: one starting with one of
 * `starts`, whatever its value, or `to` where `to` says: as its first
 * word (`to`, `toAddress`), or as its first or last (`sendTo`), unless
 * its value names nobody (a date range's `to`). A name outside plain
 * ASCII can't be read by words (`rеcipients` with a Cyrillic е), so it
 * counts as naming people.
 */
const namesPeople = (
  [name, schema]: Property,
  starts: readonly string[],
  to: "none" | "first" | "either"
): boolean => {
  if (!plainName.test(name)) {
    return true;
  }
  const nameWords = wordsOf(name);
  if (
    nameWords.some((word) => starts.some((start) => word.startsWith(start)))
  ) {
    return true;
  }
  const toFirst = to !== "none" && nameWords[0] === "to";
  const toLast = to === "either" && nameWords.at(-1) === "to";
  return (toFirst || toLast) && !namesNobody(schema);
};

/** What the rules find in a tool's name and input schema. */
interface Findings {
  /** Its name leads with a verb that reads. */
  reads: boolean;
  /** Its name holds a verb that changes something. */
  changes: boolean;
  /**
   * Its input names people or an address it reaches, or has a flag that
   * sends (`sendNow`, `notify`), whatever it does.
   */
  recipients: boolean;
  /**
   * Its input names people or places a change of it acts on, or its name
   * delivers to people, or one of its input's sends (`notify_attendees`).
   */
  targets: boolean;
  /** Its name reads or writes what people said. */
  conversations: boolean;
  /**
   * Its name writes where people talk, not a draft: a word for what they
   * said with a word that writes (`create_chat_message`), not one that
   * only sorts it (`label_email`).
   */
  writesConversations: boolean;
}

/** What the rules find in the tool `name` taking `inputSchema`. */
const findingsOf = (name: string, inputSchema: Json): Findings => {
  const words = wordsOf(name);
  const delivers = (word: string) =>
    isOneOf(sendingWords, word) || isOneOf(answeringWords, word);
  const properties = allProperties(inputSchema);
  // A draft is written for its person to send: whoever it is addressed to
  // is reached only by the send, which is a tool of its own. Only a draft
  // that is written, not one that is sent, approved or acted on otherwise.
  // What else it acts on (an assignee, a channel), or an input that sends
  // it (`scheduledSendTime`), still reaches others.
  const draft =
    words.some((word) => word === "draft" || word === "drafts") &&
    words.some((word) => writingWords.has(word)) &&
    words.every(
      (word) =>
        !isOneOf(sendingWords, word) &&
        (!isOneOf(changeWords, word) ||
          writingWords.has(word) ||
          answeringWords.has(word))
    );
  const names = (starts: readonly string[], to: "none" | "first" | "either") =>
    properties.some((property) => namesPeople(property, starts, to));
  const sends = ([property]: Property) =>
    sendingStems.some((stem) => property.toLowerCase().includes(stem));
  const known = new Map<Json, boolean>();
  const clean = new Set<Json>();
  return {
    reads:
      readVerbs.has(words[0] ?? "") ||
      (readVerbs.has(words[1] ?? "") && !delivers(words[0] ?? "")),
    changes: words.some((word) => isOneOf(changeWords, word)),
    recipients:
      (!draft && names(recipientWords, "first")) ||
      names(addressWords, "none") ||
      properties.some(
        (property) =>
          sends(property) &&
          (mentionsFlag(property[1], inputSchema, clean) ||
            mayBeFlag(property[1], inputSchema, known))
      ),
    targets:
      names(targetWords, draft ? "none" : "either") ||
      (!draft && words.some(delivers)) ||
      properties.some(sends),
    conversations: words.some((word) => conversationWords.has(word)),
    writesConversations:
      !draft &&
      words.some((word) => conversationWords.has(word)) &&
      words.some((word) => writingWords.has(word)),
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
  const hintedChange =
    annotations.readOnlyHint === false || annotations.destructiveHint === true;
  // A change its name doesn't say, known from nothing or only from a hint,
  // is one the rules don't recognise: it may reach anyone.
  if (!found.changes && (!found.reads || hintedChange)) {
    return "reach-others";
  }
  const readOnly = found.reads && !found.changes && !found.recipients;
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
 * What tool `name` taking `input` declares at least, where its connector
 * says `declared`: a read named for a change is a change, and a tool the
 * rules find reaching others reaches others. They find that where its
 * input names people it reaches, or it writes where people talk. Whether
 * what it reads, or only sorts (`mail.label`), is the person's own or
 * others' conversations stays the declaration's to say: the rules only
 * guess it from a name word.
 */
export const ruledDeclaration = (
  name: string,
  input: Json,
  declared: { readOnly: boolean; reach: ToolReach }
): { readOnly: boolean; reach: ToolReach } => {
  const found = findingsOf(name, input);
  const readOnly = declared.readOnly && !found.changes;
  const reachesOthers =
    reachOf(found, readOnly, declared.reach) === "others" ||
    (!readOnly && found.writesConversations);
  const raised =
    reachesOthers &&
    toolClassOf({ readOnly, reach: declared.reach }) !== "reach-others";
  return { readOnly, reach: raised ? "others" : declared.reach };
};

/**
 * Why the declaration of tool `name` claims less than the rules find, if
 * it does: it is one Grasp never runs; it claims to read but sends a
 * request other than a GET or HEAD; or it claims less than
 * `ruledDeclaration` gives it.
 */
export const declarationProblem = (
  name: string,
  { readOnly, reach, routes, contract }: DeclaredTool
): string | undefined => {
  if (isNeverTool(name)) {
    return "Grasp never runs it";
  }
  if (readOnly && routes.some(({ method }) => !readMethods.has(method))) {
    return "it is read-only, so it sends only GET and HEAD requests";
  }
  const ruled = ruledDeclaration(name, contract.input, { readOnly, reach });
  if (ruled.readOnly !== readOnly) {
    return "it is read-only, but its name says it changes something";
  }
  if (ruled.reach !== reach) {
    return "its input names people or places it reaches, or it writes where people talk, so it reaches others";
  }
  return undefined;
};
