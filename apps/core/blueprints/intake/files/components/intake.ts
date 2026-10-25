// What the intake's screen shows of its store, and the checks it makes
// before it sends a draft: the same bounds as the schema's (schema.ts),
// which the App's functions check again (operations/drafts.ts).

import type { Id } from "@grasp-os/sdk";

/** What a statement can be about, and how the screen names each. */
export const tagLabels = {
  goal: "Goal",
  blocker: "Blocker",
  time_sink: "Time sink",
  handover: "Handover",
  tool: "Tool",
  rule: "Rule",
} as const;
export type StatementTag = keyof typeof tagLabels;
export const statementTags = [
  "goal",
  "blocker",
  "time_sink",
  "handover",
  "tool",
  "rule",
] as const satisfies readonly StatementTag[];

/** How a source was given, and how the screen names each. */
export const mediumLabels = {
  interview: "Interview",
  chat: "Chat",
  document: "Document",
  other: "Other",
} as const;
export type SourceMedium = keyof typeof mediumLabels;
export const sourceMedia = [
  "interview",
  "chat",
  "document",
  "other",
] as const satisfies readonly SourceMedium[];

export interface DraftSource {
  title: string;
  medium: SourceMedium;
  /** YYYY-MM-DD. */
  date: string;
  from: string;
  notes: string;
}

export interface DraftStatement {
  text: string;
  tags: StatementTag[];
  quote: string;
}

export interface Draft {
  source: DraftSource;
  statements: DraftStatement[];
}

/** Where a draft came from, and how the screen names each. */
export const originLabels = {
  manual: "Typed in",
  notes: "Notes",
  guest: "Stakeholder chat",
} as const;
export type Origin = keyof typeof originLabels;

/** A stakeholder chat, as the intake lists it (operations/chats.ts). */
export interface GuestChat {
  id: string;
  name: string;
  status: "open" | "finished" | "revoked" | "expired";
  turns: number;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
}

/** A draft as the editor opens it: the stored draft at its revision. */
export interface OpenedDraft {
  id: Id<"drafts">;
  revision: number;
  origin: Origin;
  draft: Draft;
}

/** What a call answers, or the code of why it was refused. */
export type Outcome<T> = { ok: T } | { error: string };

export const shortTextMax = 200;
export const quoteMax = 1000;
export const notesMax = 30_000;
export const statementsMax = 90;

/** Today, as YYYY-MM-DD, where the person is. */
export const today = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
};

/** A new draft, with nothing in it yet. */
export const emptyDraft = (): Draft => ({
  source: {
    title: "",
    medium: "interview",
    date: today(),
    from: "",
    notes: "",
  },
  statements: [],
});

/** A new statement, with nothing in it yet. */
export const emptyStatement = (): DraftStatement => ({
  text: "",
  tags: [],
  quote: "",
});

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * Why `draft` can't be kept as it is, if it can't: what the server would
 * refuse, said before it is sent. Saving it also needs a statement.
 */
export const draftProblem = (draft: Draft): string | undefined => {
  const { source, statements } = draft;
  if (source.title.trim() === "") {
    return "Give the source a title.";
  }
  if (!datePattern.test(source.date)) {
    return "Give the source its date.";
  }
  if (source.notes.length > notesMax) {
    return `Notes are at most ${notesMax.toLocaleString()} characters.`;
  }
  if (statements.length > statementsMax) {
    return `A source has at most ${statementsMax} statements.`;
  }
  for (const [index, statement] of statements.entries()) {
    if (statement.text.trim() === "") {
      return `Write statement ${index + 1}, or remove it.`;
    }
    if (statement.tags.length === 0) {
      return `Tag statement ${index + 1}.`;
    }
  }
  return undefined;
};

const codeOf = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : "app.unreachable";

/**
 * What `run` resolves with, or the code of why it rejected: for the App's
 * functions and the platform's calls (a run started, read), which reject
 * when refused. So no call ends in an unhandled rejection.
 */
export const settle = async <T>(run: () => Promise<T>): Promise<Outcome<T>> => {
  try {
    return { ok: await run() };
  } catch (error) {
    return { error: codeOf(error) };
  }
};

/** What a refusal means to the person taking intake. */
export const refusal = (code: string): string => {
  switch (code) {
    case "data.conflict":
    case "data.reads_changed": {
      return "Someone changed this draft since you opened it. Open it again to see their changes.";
    }
    case "intake.not_found": {
      return "This draft is gone: someone saved or discarded it.";
    }
    case "intake.invalid":
    case "data.invalid":
    case "contract.invalid_args": {
      return "That doesn't fit: check every statement has text and a tag, the source a title and a date that exists, and that the notes and quotes aren't too long to keep.";
    }
    case "contract.input_too_large": {
      return "This draft is too long to keep: shorten its notes, quotes or statements.";
    }
    case "intake.no_statements": {
      return "Add a statement to save.";
    }
    case "data.access_denied":
    case "data.write_denied": {
      return "Only the App's builders take intake.";
    }
    case "resource.unavailable": {
      return "Intake can't do that yet: an admin approves what it uses (its model, its guest chats) first.";
    }
    case "intake.empty_chat": {
      return "Nobody wrote in that chat yet.";
    }
    case "guest.too_many_open": {
      return "Too many chats are open. Revoke some, or wait for them to end.";
    }
    case "guest.no_model": {
      return "No model is set up for this deployment, so nobody can be invited.";
    }
    case "guest.invalid": {
      return "That can't be invited: give their name, of at most 100 characters.";
    }
    case "guest.not_found": {
      return "That chat is gone.";
    }
    case "app.unreachable": {
      return "Grasp can't be reached right now. Try again in a moment.";
    }
    default: {
      return `That didn't work (${code}).`;
    }
  }
};
