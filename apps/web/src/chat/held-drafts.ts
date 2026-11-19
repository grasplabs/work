import type { PendingAction } from "@grasp-os/shared/connect";
import { z } from "zod";

import type {
  DraftPerson,
  EmailDraftValue,
  EventDraftValue,
  TaskDraftValue,
} from "../grasp/draft/index.ts";

// A held write as the thing it makes, on Grasp UI's drafts: an email to
// send (`mail.send`), an event for the person's calendar
// (`calendar.create`), a task (`todo.create`, `planner.create`), from
// Microsoft 365 and Google Workspace alike. Each is built from the exact
// input confirming runs, value for value, never reworded; what a draft has
// no place for is named in `left`, for the page to show beside it. Any
// other write, or an input that doesn't read as its tool's, has none and
// keeps its card.

/** How a draft shows one of the input's values. */
export type ShownAs =
  /** On one line, a field or a person's chip, which may cut it at its edge. */
  | "line"
  /** In a field that grows with its words. */
  | "grows"
  /** Whole: a day, or a time to the minute. */
  | "whole"
  /** Only in part: a time's seconds, which a draft doesn't show. */
  | "part";

/** One of the input's properties as its draft shows it. */
export interface DraftShown {
  input: string;
  as: ShownAs;
  values: readonly string[];
}

/** A held write as a draft: the kind, its value, and what of the input it shows and leaves out. */
export type HeldDraft = (
  | { kind: "email"; draft: EmailDraftValue }
  | { kind: "event"; draft: EventDraftValue }
  | { kind: "task"; draft: TaskDraftValue }
) & {
  /** The input's properties the draft shows, and how. */
  shown: readonly DraftShown[];
  /** The input's properties the draft has no place for. */
  left: readonly string[];
};

/**
 * The zone a draft's times are shown in. An input's times are wall-clock
 * times (with its zone beside them) and a task's due a day: each is put in
 * this frame as written and shown back in it, so the draft says exactly
 * the input's own time and day, never one converted from it.
 */
export const draftTimeZone = "UTC";

const addresses = z.array(z.string());
const wallClock = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

const emailInput = z.object({
  mailbox: z.string(),
  to: addresses,
  cc: addresses.optional(),
  bcc: addresses.optional(),
  subject: z.string(),
  body: z.string(),
});

// Microsoft 365 names the calendar by its mailbox, Google by its address.
const eventInput = z.object({
  mailbox: z.string().optional(),
  calendar: z.string().optional(),
  subject: z.string(),
  start: wallClock,
  end: wallClock,
  location: z.string().optional(),
  body: z.string().optional(),
});

const todoInput = z.object({
  mailbox: z.string(),
  title: z.string(),
  due: day.optional(),
  note: z.string().optional(),
});

const plannerInput = z.object({ title: z.string(), due: day.optional() });

/** A wall-clock time in the drafts' frame: ISO with its offset. */
const timeOf = (wall: string): string =>
  `${wall.length === 16 ? `${wall}:00` : wall}Z`;

/** A due day in the drafts' frame: ISO with its offset, the day's start. */
const dayOf = (due: string): string => `${due}T00:00:00Z`;

/** Whether `iso` is a real moment that says back what it was made from (no 30 February). */
const isReal = (iso: string): boolean => {
  const at = new Date(iso);
  return (
    !Number.isNaN(at.getTime()) && at.toISOString().startsWith(iso.slice(0, 19))
  );
};

/** How a draft shows a time: whole to the minute, its seconds not. */
const timeShown = (input: string, wall: string): DraftShown => ({
  input,
  as: wall.length === 16 || wall.endsWith(":00") ? "whole" : "part",
  values: [wall],
});

/** An address as a person in a draft: the address is all the input says of them. */
const personOf = (address: string): DraftPerson => ({
  name: address,
  email: address,
});

/** The calendar or task list's owner, the person themselves, as a draft names them. */
const youOf = (address: string): DraftPerson => ({
  ...personOf(address),
  you: true,
});

/** The input's properties a draft that shows `shown` has no place for. */
const leftOf = (
  input: Record<string, unknown>,
  shown: readonly DraftShown[]
): string[] =>
  Object.keys(input).filter((key) => !shown.some((each) => each.input === key));

const emailOf = (input: Record<string, unknown>): HeldDraft | undefined => {
  const read = emailInput.safeParse(input);
  if (!read.success) {
    return undefined;
  }
  const { to, cc, bcc, subject, body } = read.data;
  const shown: DraftShown[] = [
    { input: "to", as: "line", values: to },
    { input: "subject", as: "line", values: [subject] },
    { input: "body", as: "grows", values: [body] },
  ];
  if (cc !== undefined) {
    shown.push({ input: "cc", as: "line", values: cc });
  }
  if (bcc !== undefined) {
    shown.push({ input: "bcc", as: "line", values: bcc });
  }
  return {
    kind: "email",
    draft: {
      to: to.map(personOf),
      cc: cc?.map(personOf),
      bcc: bcc?.map(personOf),
      subject,
      body,
    },
    shown,
    left: leftOf(input, shown),
  };
};

const eventOf = (input: Record<string, unknown>): HeldDraft | undefined => {
  const read = eventInput.safeParse(input);
  if (!read.success) {
    return undefined;
  }
  const { mailbox, calendar, subject, start, end, location, body } = read.data;
  const owner = mailbox ?? calendar;
  const ownerKey = mailbox === undefined ? "calendar" : "mailbox";
  if (owner === undefined || !isReal(timeOf(start)) || !isReal(timeOf(end))) {
    return undefined;
  }
  const shown: DraftShown[] = [
    { input: ownerKey, as: "line", values: [owner] },
    { input: "subject", as: "grows", values: [subject] },
    timeShown("start", start),
    timeShown("end", end),
  ];
  if (location !== undefined) {
    shown.push({ input: "location", as: "line", values: [location] });
  }
  if (body !== undefined) {
    shown.push({ input: "body", as: "grows", values: [body] });
  }
  return {
    kind: "event",
    draft: {
      title: subject,
      start: timeOf(start),
      end: timeOf(end),
      // Nobody is invited: the event goes in its owner's own calendar.
      people: [youOf(owner)],
      place: location,
      description: body,
    },
    shown,
    left: leftOf(input, shown),
  };
};

/** A task in a person's own To Do list, or an unassigned one in a Planner plan. */
const taskOf = (
  input: Record<string, unknown>,
  {
    title,
    due,
    note,
    owner,
  }: { title: string; due?: string; note?: string; owner?: string }
): HeldDraft | undefined => {
  if (due !== undefined && !isReal(dayOf(due))) {
    return undefined;
  }
  const shown: DraftShown[] = [
    { input: "title", as: "grows", values: [title] },
  ];
  if (due !== undefined) {
    shown.push({ input: "due", as: "whole", values: [due] });
  }
  if (note !== undefined) {
    shown.push({ input: "note", as: "grows", values: [note] });
  }
  if (owner !== undefined) {
    shown.push({ input: "mailbox", as: "line", values: [owner] });
  }
  return {
    kind: "task",
    draft: {
      title,
      due: due === undefined ? undefined : dayOf(due),
      people: owner === undefined ? [] : [youOf(owner)],
      note,
    },
    shown,
    left: leftOf(input, shown),
  };
};

const todoOf = (input: Record<string, unknown>): HeldDraft | undefined => {
  const read = todoInput.safeParse(input);
  return read.success
    ? taskOf(input, { ...read.data, owner: read.data.mailbox })
    : undefined;
};

const plannerOf = (input: Record<string, unknown>): HeldDraft | undefined => {
  const read = plannerInput.safeParse(input);
  return read.success ? taskOf(input, read.data) : undefined;
};

/** Each write that reads as a draft, by its tool's name. */
const draftsByTool: Record<
  string,
  ((input: Record<string, unknown>) => HeldDraft | undefined) | undefined
> = {
  "mail.send": emailOf,
  "calendar.create": eventOf,
  "todo.create": todoOf,
  "planner.create": plannerOf,
};

const inputObject = z.record(z.string(), z.unknown());

/** The input as JSON's object, if it is one. */
const objectOf = (input: string): Record<string, unknown> | undefined => {
  try {
    const read = inputObject.safeParse(JSON.parse(input));
    return read.success ? read.data : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The held write as a draft, if its tool makes one. Only a native
 * connector's tool describes its call, which no Composio tool does: a
 * write without a description is never taken for one of these.
 */
export const draftOf = (action: PendingAction): HeldDraft | undefined => {
  const make = draftsByTool[action.action];
  if (make === undefined || action.description === undefined) {
    return undefined;
  }
  const input = objectOf(action.input);
  return input === undefined ? undefined : make(input);
};
