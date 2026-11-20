// The drafts' own words, in English. The product gives them in its languages through GraspWords
// (src/words): one `draft` entry, the frame's words and then each kind's. A word built from others,
// or from a date, is a function; dates are written with Intl in the host's locale and time zone.

/** A time of day ("14:00"), in the zone given. */
const clock = (iso: string, timeZone: string | undefined) =>
  new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));

/** A day ("Thu 19 Nov"), in the zone given. */
const day = (iso: string, timeZone: string | undefined) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone,
  }).format(new Date(iso));

/** A length of time in minutes, as people say it ("30 min", "1 h 30 min"). */
const length = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) {
    return `${rest} min`;
  }
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
};

export const draftWords = {
  /** ReplyDraft: the email's words, and these. */
  reply: {
    /** The kind, in the head and said with the subject. */
    kind: "Reply",
    /** The main action. */
    send: "Send reply",
    /** Said once it was sent. */
    sent: "Reply sent",
    /** Over the folded original ("Jerry van der Horst wrote on Tue 17 Nov, 09:12"). */
    wrote: (name: string, iso: string, timeZone: string | undefined) =>
      `${name} wrote on ${day(iso, timeZone)}, ${clock(iso, timeZone)}`,
  },
  /** SheetDraft. */
  sheet: {
    /** The kind, said with the sheet's name. */
    kind: "Sheet",
    /** The title field's name and placeholder. */
    title: "Sheet name",
    /** The main action. */
    create: "Create sheet",
    /** Said once it was made, before the time. */
    created: "Sheet created",
    /** Where it will be saved, shown beside it. */
    saveTo: "Saves to",
    /** The sheet's size, under the grid ("12 rows, 4 columns"). */
    size: (rows: number, columns: number) => {
      const rowWords =
        rows === 0 ? "No rows" : `${rows} ${rows === 1 ? "row" : "rows"}`;
      const columnWords =
        columns === 0
          ? "no columns"
          : `${columns} ${columns === 1 ? "column" : "columns"}`;
      return `${rowWords}, ${columnWords}`;
    },
    /** A date cell ("31 Oct 2026"), from its ISO date. */
    date: (iso: string) =>
      new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)),
    /** The sent line's time ("14:02"). */
    time: clock,
  },
  /** MessageDraft. */
  message: {
    /** The kind, in the head and said with where it goes. */
    kind: "Message",
    /** Where it goes, shown beside it. */
    to: "To",
    /** The message's name and placeholder. */
    text: "Message",
    /** The main action. */
    send: "Send message",
    /** Said once it was sent, before the time. */
    sent: "Sent",
    /** The sent line's time ("14:02"). */
    time: clock,
  },
  /** TaskDraft. */
  task: {
    /** The kind, said with the draft's name. */
    kind: "Task",
    /** The title field's name and placeholder. */
    title: "Task name",
    /** The main action. */
    add: "Add task",
    /** Said once it was added, before the time. */
    added: "Added to your tasks",
    /** The rows' names. */
    due: "Due",
    people: "Who",
    note: "Note",
    /** Placeholders of the rows still empty. */
    addDue: "Add a due date",
    addNote: "Add a note",
    /** The due time in the popover. */
    time: clock,
    /** The due row ("Thu 19 Nov · 17:00"). */
    at: (iso: string, timeZone: string | undefined) =>
      `${day(iso, timeZone)} · ${clock(iso, timeZone)}`,
    /** The due row of a day with no time ("Fri 20 Nov"), from its date ("2026-11-20"): the same day in every zone. */
    on: (date: string) => day(`${date}T00:00:00Z`, "UTC"),
  },
  /** EmailDraft. */
  email: {
    /** The kind, in the head and said with the subject. */
    kind: "Email",
    /** The rows' names, shown beside them. */
    to: "To",
    cc: "Cc",
    bcc: "Bcc",
    subject: "Subject",
    /** The body's name and placeholder. */
    body: "Message",
    /** Opens the Cc and Bcc rows. */
    addCc: "Cc / Bcc",
    /** The main action. */
    send: "Send",
    /** Attach's name. */
    attach: "Attach a file",
    /** Said once it was sent, before the time. */
    sent: "Sent",
    /** The sent line's time ("14:02"). */
    time: clock,
  },
  /** The frame, every kind. */
  frame: {
    /** The quiet way out, at the foot's start: the one word for leaving any kind of draft. */
    dismiss: "Discard",
    /** Said and shown once discarded. */
    dismissed: "Draft discarded",
    /** Brings a dismissed draft back. */
    restore: "Restore",
    /** Takes back what was made, while the host can. */
    undo: "Undo",
    /** On the main action while it works. */
    working: "Working",
    /** On the main action when it failed, beside its alert mark: press again. */
    failed: "Try again",
    /** A person's chip's remove, by their name. */
    remove: (name: string) => `Remove ${name}`,
    /** The person looking, in a lane or a chip. */
    you: "You",
  },
  /** EventChangeDraft: the event's words, and these. */
  eventChange: {
    /** The kind, said with the draft's name. */
    kind: "Event change",
    /** The main action. */
    save: "Save changes",
    /** Said once it was saved, before the time. */
    saved: "Event updated",
    /** Said before a value as it was, struck under the new one. */
    was: "Was",
    /** Beside a guest the change adds. */
    added: "New",
    /** Said before a guest the change takes off, struck. */
    removed: "Removed",
  },
  /** EventDraft. */
  event: {
    /** The kind, said with the draft's name. */
    kind: "Event",
    /** The title field's name and placeholder. */
    title: "Event name",
    /** The main action. */
    create: "Create event",
    /** The provider's link, when `onOpen` is given. */
    open: "Open in calendar",
    /** Said once it was made, before the time. */
    created: "Added to the calendar",
    /** The day view's name. */
    day: "The day, with everyone's busy time",
    /** Over a block where the event meets someone's busy time. */
    conflicts: "Conflicts",
    /** A lane's busy time, for a screen reader. */
    busy: (name: string, from: string, to: string) =>
      `${name}: busy ${from} to ${to}`,
    /** The rows' names. */
    when: "When",
    /** The when editor's times. */
    starts: "Starts",
    ends: "Ends",
    people: "People",
    call: "Video call",
    place: "Place",
    description: "Description",
    /** Placeholders of the rows still empty. */
    addPlace: "Add a place",
    addDescription: "Add a description",
    /** An hour down the side, and a time in a block ("14:00"). */
    time: clock,
    /** The when row ("Thu 19 Nov · 14:00 → 14:30"). */
    span: (start: string, end: string, timeZone: string | undefined) =>
      `${day(start, timeZone)} · ${clock(start, timeZone)} → ${clock(end, timeZone)}`,
    /** The block's line under the title ("14:00 · 30 min"). */
    lasts: (start: string, minutes: number, timeZone: string | undefined) =>
      `${clock(start, timeZone)} · ${length(minutes)}`,
  },
};

export type DraftWords = typeof draftWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    draft: DraftWords;
  }
}
