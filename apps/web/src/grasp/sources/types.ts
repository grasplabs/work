import type { ActivityStep } from "../agent-activity";
import type { Brand } from "../brand-icon";
// What a source is, shared by the parts of Sources (sources.tsx, citation.tsx, list.tsx, card.tsx).
// One shape for every kind: the fields every row shows, then the detail a kind's card draws.
import type { IconData } from "../icons";
import type { KeyValueItem } from "../key-value";
import type { StepperStep } from "../stepper";

/**
 * What a source is. It chooses the source's mark and what its card shows:
 * `file` a document, sheet, deck or image; `web` a page on a site; `record` a deal, ticket, invoice
 * or event in an app; `message` a chat message or an email; `meeting` a call with a transcript;
 * `person` someone who said or owns something; `agent` an agent's run; `workflow` a workflow's run;
 * `table` a table or a query; `memory` something the company's brain remembers; `code` lines of
 * a file of code.
 */
export type SourceKind =
  | "file"
  | "web"
  | "record"
  | "message"
  | "meeting"
  | "person"
  | "agent"
  | "workflow"
  | "table"
  | "memory"
  | "code";

/** Whether the person can open a source: `open`, `locked` (it is there, but not for them) or `gone`. */
export type SourceAccess = "open" | "locked" | "gone";

/** Someone in a source: a meeting's people, a message's sender. */
export interface SourcePerson {
  /** Their name ("Amara Okafor"). */
  name: string;
  /** Their portrait's address; their initials stand in without one. */
  src?: string;
}

/** One line of a meeting's transcript. */
export interface SourceTranscriptLine {
  /** When in the meeting it was said ("12:04"). */
  time: string;
  /** Who said it. */
  who: string;
  /** What they said. */
  line: string;
  /** The line the answer quotes: it is marked. */
  quoted?: boolean;
}

/** One source an answer drew on. Its number is its place in the list, from 1. */
export interface Source {
  /**
   * What it is, which chooses its mark and its card.
   * @default "web"
   */
  kind?: SourceKind;
  /** Its title, as the thing calls itself ("Churn report, Q3", "Amara Okafor"). */
  title: string;
  /**
   * Where it lives, in a few quiet words: a site, a folder, an app and its object ("HubSpot ·
   * Deal", "#customer-success", "Finance / Reports").
   */
  origin: string;
  /** When: the message's time, the meeting's date, when it was read or last changed ("Tuesday 14:02"). */
  when?: string;
  /** How fresh it is, when that matters: "live", "2 days old". */
  fresh?: string;
  /** Its address, opened from its row and its card. Leave it out for a source with nowhere to go. */
  href?: string;
  /** The part the answer used: the passage, the line, what was said. Shown in the row and the card. */
  quote?: string;
  /** The words before and after the quote, quieter, so the card shows it in context. */
  context?: { before?: string; after?: string };
  /** Where in the source the quote sits: "Page 4 of 12", "Lines 18–24". */
  place?: string;
  /** Its mark, in place of its kind's: a file type from the icons entry (`@/components/grasp/icons`) (Pdf, Doc), or any icon. */
  icon?: IconData;
  /** The address of the site's own small icon, for a web page, in place of `icon`. */
  favicon?: string;
  /** The app it is from, whose mark it wears: a record or a message ("slack", "stripe", "google-drive"). */
  brand?: Brand;
  /** The person it is, or who sent it: their portrait marks a person and a message. */
  person?: SourcePerson;
  /** A record's fields the answer used, or a memory's facts: shown as rows in the card. */
  fields?: readonly KeyValueItem[];
  /** A meeting's people, shown as a row of portraits. */
  people?: readonly SourcePerson[];
  /** A meeting's lines around the moment quoted. */
  transcript?: readonly SourceTranscriptLine[];
  /** An agent's steps, shown in its card, collapsed, as Agent activity draws them. */
  steps?: readonly ActivityStep[];
  /** A workflow's steps, shown in its card as a small Stepper. */
  flow?: readonly StepperStep[];
  /** The workflow's step that produced the fact, counted from 0: marked in its card. */
  usedStep?: number;
  /** A workflow run's state, in a word, shown as a badge ("Succeeded", "Running"). */
  runState?: {
    label: string;
    tone: "neutral" | "success" | "attention" | "danger" | "info";
  };
  /** A table's peek: its column names and up to three rows. */
  peek?: { columns: readonly string[]; rows: readonly (readonly string[])[] };
  /** Lines of code, with the ones the answer used marked (counted from 1). */
  code?: { text: string; language?: string; marked?: readonly number[] };
  /**
   * Whether the person can open it. A locked source says what it is but cannot be opened; a gone
   * one says it could not be opened, and why.
   * @default "open"
   */
  access?: SourceAccess;
  /** Why it could not be opened, in a few words: "No access", "Deleted", "Timed out". */
  reason?: string;
  /**
   * It could not be opened (moved, private, gone). The same as `access: "gone"`, kept for the
   * Sources that set it before `access` existed.
   */
  unavailable?: boolean;
}

/** Every word Sources shows or says, so a product can translate them. */
export interface SourcesLabels {
  /**
   * A marker's name: "Source 1".
   * @default Source {number}
   */
  source: (number: number) => string;
  /**
   * A second or later mention of one source, in a marker's name: "second mention".
   * @default first mention, second mention, to the tenth; then mention {index}
   */
  mention: (index: number) => string;
  /**
   * Said of a source that could not be opened.
   * @default Could not be opened
   */
  gone: string;
  /**
   * Said of a source the person cannot open.
   * @default You cannot open this
   */
  locked: string;
  /**
   * Said in a marker's name, after its title, of a source that could not be opened.
   * @default could not be opened
   */
  goneInName: string;
  /**
   * Said in a marker's name, after its title, of a source the person cannot open.
   * @default you cannot open it
   */
  lockedInName: string;
  /**
   * The pile's count: "12 sources".
   * @default {count} {count === 1 ? "source" : "sources"}
   */
  count: (count: number) => string;
  /**
   * A kind, counted, in the pile's words and the group headings: "4 files".
   * @default {count} and the kind in words, one or many: 1 file, 4 files, 3 pages, 2 people
   */
  kind: (kind: SourceKind, count: number) => string;
  /**
   * The button that shows the rest of a long list: "Show 8 more".
   * @default Show {count} more
   */
  showMore: (count: number) => string;
  /**
   * The button that folds it again.
   * @default Show fewer
   */
  showFewer: string;
  /**
   * The order switch's name and its two choices.
   * @default Order
   */
  order: string;
  /**
   * @default By relevance
   */
  byRelevance: string;
  /**
   * @default By kind
   */
  byKind: string;
  /**
   * The pile's action, said after its count: "Show them".
   * @default Show them
   */
  open: string;
  /**
   * The open list's action that folds it back into the pile.
   * @default Fold them away
   */
  close: string;
  /**
   * A link in an agent's or a workflow's card to its run.
   * @default Open the run
   */
  openRun: string;
  /**
   * A link in a memory's card to correct it.
   * @default Correct it
   */
  correct: string;
}
