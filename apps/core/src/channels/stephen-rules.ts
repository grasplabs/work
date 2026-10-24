import { sha256Hex } from "@grasp-os/shared/encoding";

// What the prototype learned about acting safely in a chat app, on work's
// agent (GRA-719). In the prototype Stephen's turn checked every value
// before it went on a card; here the agent writes code, so the checks sit
// where its write is held: core refuses the call before connect sees it
// (agent-connections.ts), for a chat that came through a chat platform.
//
// The ways a held write goes wrong, and the check for each:
// - the model makes up an ID or a value, or takes one from its memory: an
//   ID-like value must be in what the person said in the chat, or in
//   something the chat read (`untraced`);
// - a mail or a file names someone, and the model writes to them: an
//   address must be in the person's own words, never only in what was read
//   (`recipientUnsaid`), as what a chat reads is data, not instructions;
// - the model leaves a placeholder in for what it doesn't know
//   (`placeholder`);
// - the model adds a field the action doesn't take, which a connector
//   might pass on or ignore (`unknownField`).
// Composed text (a subject, a body) is the model's own words and isn't
// traced: what it says is shown to the person on the card, whole.
//
// And in Stephen's own words there are no links: a link he writes could
// lead anywhere, and the sources under an answer come from code (what the
// chat read), not from the model.

/** Why a held write was refused before it was held, as `agentErrors` names it. */
export type HeldWriteRefusal =
  | "agent.write_untraced"
  | "agent.write_recipient_unsaid"
  | "agent.write_placeholder"
  | "agent.write_unknown_field"
  | "agent.write_unchecked";

/** What a write is checked against. */
export interface HeldWriteTrace {
  /** What the person said in the chat, all of it. */
  said: string;
  /** What the chat read: each text value of what its reads returned. */
  read: readonly string[];
}

/** An email address, wherever it stands in a value. */
const emailAddress = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/gu;

/** A value that is an email address and nothing else. */
const onlyEmailAddress = /^[\w.%+-]+@[\w-]+(?:\.[\w-]+)+$/u;

/** A date, a time or both (ISO 8601), which the model works out from words. */
const dateOrTime =
  /^(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}:\d{2}(?::\d{2})?)$/u;

/** An ISO 8601 duration (`PT30M`), which the model works out from words. */
const duration = /^P(?:\d+[YMWD])*(?:T(?:\d+(?:\.\d+)?[HMS])+)?$/u;

/** A value that stands for something it isn't: what a model leaves in for what it doesn't know. */
const placeholders: readonly RegExp[] = [
  /\{\{[^}]*\}\}/u,
  /\$\{[^}]*\}/u,
  /<[A-Z][A-Z0-9_ ]{1,40}>/u,
  /<(?:your|their|the|insert|recipient|name|email|date|time)\b[^>]{0,40}>/iu,
  /\[[A-Z][A-Z0-9_ ]{1,40}\]/u,
  /\[(?:your|their|insert|recipient|name|email|date|time|company)\b[^\]]{0,40}\]/iu,
  /\b(?:TODO|FIXME|PLACEHOLDER)\b/u,
  /lorem ipsum/iu,
  /\b(?:X{3,}|x{3,})\b/u,
  /@example\.(?:com|org|net)\b/iu,
];

/** The shortest value read as an ID, rather than a word. */
const shortestId = 6;

/**
 * Whether `value` names something, the way an ID does: one token, with a
 * digit in it, that isn't a date, a time or a duration the model worked
 * out. Words ("high", "Europe/Amsterdam") and composed text aren't.
 */
const isIdLike = (value: string): boolean =>
  value.length >= shortestId &&
  !/\s/u.test(value) &&
  /\d/u.test(value) &&
  !dateOrTime.test(value) &&
  !duration.test(value);

/** A character that can stand inside an address or an ID. */
const tokenChar = /[\w.%+@-]/u;

/**
 * Whether `text` holds `value` as a whole token, not inside a longer one:
 * `smith@acme.test` isn't in `john.smith@acme.test`, nor `AAMkAD-0042` in
 * `AAMkAD-00421`. A full stop may follow it, as one ends a sentence.
 */
const holdsToken = (text: string, value: string): boolean => {
  for (
    let at = text.indexOf(value);
    at !== -1;
    at = text.indexOf(value, at + 1)
  ) {
    const before = text[at - 1];
    const after = text[at + value.length];
    const next = text[at + value.length + 1];
    const endsHere =
      after === undefined ||
      !tokenChar.test(after) ||
      (after === "." && (next === undefined || !tokenChar.test(next)));
    if ((before === undefined || !tokenChar.test(before)) && endsHere) {
      return true;
    }
  }
  return false;
};

/** Every text value in `value`, however deep. */
export const textsOf = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(textsOf);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(textsOf);
  }
  return [];
};

/**
 * Why a write from a chat platform's chat can't be held, or `undefined`
 * when it can: its `input` against the fields its action takes (`inputs`,
 * `null` when they can't be read now) and what it may come from (`trace`).
 */
export const heldWriteRefusal = (
  input: unknown,
  inputs: readonly string[] | null,
  { said, read }: HeldWriteTrace
): HeldWriteRefusal | undefined => {
  if (inputs === null) {
    return "agent.write_unchecked";
  }
  if (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Object.keys(input).some((field) => !inputs.includes(field))
  ) {
    return "agent.write_unknown_field";
  }
  const values = textsOf(input);
  if (values.some((value) => placeholders.some((made) => made.test(value)))) {
    return "agent.write_placeholder";
  }
  const saidLower = said.toLowerCase();
  const readLower = read.join("\n").toLowerCase();
  // A value that is an address is someone the write reaches: the person
  // must have said it. One inside longer text (a reply quoting the mail
  // it answers) may also come from what the chat read.
  const unsaid = values.some((value) => {
    const whole = onlyEmailAddress.test(value.trim());
    return [...value.matchAll(emailAddress)].some(([found]) => {
      const address = found.toLowerCase();
      return (
        !holdsToken(saidLower, address) &&
        (whole || !holdsToken(readLower, address))
      );
    });
  });
  if (unsaid) {
    return "agent.write_recipient_unsaid";
  }
  const untraced = values.some((value) => {
    const trimmed = value.trim();
    if (!isIdLike(trimmed) || onlyEmailAddress.test(trimmed)) {
      return false;
    }
    const lower = trimmed.toLowerCase();
    return !holdsToken(saidLower, lower) && !holdsToken(readLower, lower);
  });
  return untraced ? "agent.write_untraced" : undefined;
};

/** A Markdown link: its label, and where it leads. */
const markdownLink =
  /(?<image>!?)\[(?<label>[^\]]*)\]\((?<to>[^)\s]*)(?:\s+"[^"]*")?\)/gu;

/** One Markdown link, whole, as `markdownLink` finds it. */
const oneLink = new RegExp(`^${markdownLink.source}$`, "u");

/** What a Markdown link leaves of itself in Stephen's own words. */
const linkLeft = (whole: string): string => {
  const parts = oneLink.exec(whole)?.groups;
  const citation =
    parts?.image === "" && parts.to?.startsWith("grasp:") === true;
  return citation ? whole : (parts?.label ?? "");
};

/**
 * An address written out, or between angle brackets, with the spaces
 * before it, so dropping it leaves no gap.
 */
const bareLink =
  /[ \t]*<?\b(?:https?:\/\/|www\.|mailto:)(?:[^\s<>)]*[^\s<>).,;:!?'"])?>?/giu;

/**
 * Stephen's own words without links: a Markdown link keeps its label, and
 * an address written out is dropped. Only a citation of what the chat
 * read (`grasp:`) stays, as code turns it into the answer's sources.
 */
export const withoutLinks = (text: string): string =>
  text.replaceAll(markdownLink, linkLeft).replaceAll(bareLink, "");

/**
 * How Stephen answers in a chat app, after the agent's own instructions.
 * Measured as the interviewer's text is: it changes one change at a time,
 * and every turn keeps its mark (`channelText`).
 */
const chatAppText = `This chat is in a chat app, such as Microsoft Teams, where the person reads you between other messages. How you answer here:
- Two to five sentences of running text: no headings, no lists, no tables.
- In the language the person writes in.
- Say what a fact means for their work, not only the fact.
- Speak of people by their role ("the finance lead"), never about a colleague as a person.
- Cite each document once, where you first use it. Write no other links: the sources under your answer come from what you read.
- A change waits for the person to press on a card. Ask for it only with what they said or what you read: their words for whom it goes to, IDs and values as you read them, no placeholders.`;

/** One text the model is told, and its mark. */
export interface ChannelText {
  text: string;
  /** The text's SHA-256, in hex: the same text has the same mark everywhere. */
  mark: string;
}

/** The text for a chat that came through a chat platform, and its mark. */
export const channelText = async (): Promise<ChannelText> => ({
  text: chatAppText,
  mark: await sha256Hex(chatAppText),
});

/**
 * What a held write's card says was read in its turn, as its check line
 * shows it: mail, or a company's record, and in which system (its
 * provider). Mail first: a card shows the one that asks most care.
 */
export interface TurnCheck {
  read: "mail" | "record";
  where: string;
}

/** Of what a turn read, what its check line shows; `null` for nothing read. */
export const turnCheckOf = (reads: readonly TurnCheck[]): TurnCheck | null =>
  reads.find(({ read }) => read === "mail") ?? reads[0] ?? null;

/** Whether a read action reads mail, by its name (`mail.search`, `MAIL_SEARCH`). */
export const readsMail = (action: string): boolean =>
  /^(?:mail|gmail|outlook)[._]/iu.test(action);
