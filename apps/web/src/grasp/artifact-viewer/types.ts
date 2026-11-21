// What a renderer is told by the shell, and what it tells the shell back, so the toolbar, search,
// keyboard and link work the same for every format.
import type { RefObject } from "react";

import type { Anchor, TableShape } from "./anchor";
import type { ArtifactFormat } from "./format";
import type { ViewerAction } from "./keys";
import type { OpenedArtifact } from "./source";

/** Who wrote a comment. */
export interface CommentAuthor {
  name: string;
  /** A picture of them: a URL. Without it, their initials. */
  avatar?: string;
}

/** One comment in a thread. */
export interface CommentItem {
  id: string;
  author: CommentAuthor;
  body: string;
  /** When it was written: a date, or anything `new Date()` reads. */
  at: Date | string | number;
}

/** A thread of comments on one place in the file. */
export interface CommentThread {
  id: string;
  /** What it holds on to. */
  anchor: Anchor;
  resolved?: boolean;
  /** The first comment, then the replies, oldest first. */
  items: CommentItem[];
}

/** A thread as a renderer draws it: a cell or a box it marks itself. */
export interface DrawnNote {
  id: string;
  anchor: Anchor;
  /** The thread open now: drawn stronger. */
  active: boolean;
}

/** A place to jump to: a heading, a page. */
export interface Section {
  label: string;
  /** Its row, counted from 0. */
  row: number;
  /** For headings: 1 to 6. */
  depth?: number;
}

/**
 * A new comment on a place in the file. Give back the new thread's id (or a promise of it) and the
 * viewer opens it; give back nothing and it finds the new thread by its anchor.
 */
export type CommentHandler =
  | ((anchor: Anchor, body: string) => string | Promise<string | undefined>)
  | ((anchor: Anchor, body: string) => void);

/** What the shell can ask of a renderer. */
export interface RendererControl {
  /** Brings a row to the top of the viewport. */
  scrollToRow: (row: number) => void;
}

export interface RendererProps {
  artifact: OpenedArtifact;
  /** The words it shows and says: the product's, and English for any it left out. */
  labels: ArtifactViewerLabels;
  /** The scrolling viewport the renderer draws into. */
  scroller: HTMLElement;
  /** The zoom: a percentage, or "fit". */
  zoom: number | "fit";
  /** The search, and which of its matches is current (from 0). */
  find: string;
  match: number;
  /** The row to open at, from a link. */
  initialRow?: number;
  /** Its places to jump to, once known. */
  onSections: (sections: Section[]) => void;
  /** How many rows it has, once known. */
  onRows: (total: number) => void;
  /** The row at the top, as it scrolls. */
  onRow: (row: number) => void;
  /** How many matches the search has; `more` when there are more than it counted. */
  onMatches: (count: number, more?: boolean) => void;
  control: RefObject<RendererControl | null>;
  /** Where PDF.js's `cmaps/`, `standard_fonts/`, `wasm/` and `iccs/` folders are served, if anywhere. */
  pdfAssets?: string;
  /** For a web page: let its scripts run, inside its sandbox. */
  allowScripts?: boolean;
  /** A line under find, when find works differently here (a web page's preview). */
  onFindNote?: (note: string) => void;
  /** The text each part holds (the source; for a PDF, each page's text), once known. */
  onTexts?: (texts: readonly (string | undefined)[]) => void;
  /** For a PDF: pages whose text is wanted now (they have comments), read before others. */
  wantedParts?: readonly number[];
  /** The row a place in the text is in: to bring a comment into view. */
  onRowOf?: (rowOf: (part: number, offset: number) => number) => void;
  /** For a table: its rows' keys and its head, so a cell's comment finds its row. */
  onTable?: (table: TableShape) => void;
  /** A table's row key, from its cells; by default the row's number among the data rows. */
  rowKey?: (cells: readonly string[]) => string;
  /** Comments are on. */
  commenting?: boolean;
  /** Threads a renderer marks itself (a table's cells, an image's boxes). */
  notes?: readonly DrawnNote[];
  /** A thread's mark was chosen. */
  onOpenThread?: (id: string) => void;
  /** For a table: cells with an edit proposed, which it draws with their old and new values. */
  proposals?: readonly { id: string; anchor: Anchor; replacement: string }[];
  /** For an image: a box was drawn, to comment on. */
  onDrawAnchor?: (anchor: Anchor) => void;
  /** A short note on the file, for the toolbar: a table's rows that did not read cleanly. */
  onNote?: (note: string) => void;
}

/** Where the toolbar says you are: a PDF's page, a table's row, a line of code or text. */
export type PositionKind = "page" | "row" | "line";

/** What an agent's proposal is on, as the live region says it. */
export type ProposalTarget =
  | { kind: "insert" }
  | { kind: "words"; words: string }
  | { kind: "cell" };

/** Why a PDF did not open. */
export type PdfFailure = "locked" | "empty" | "invalid" | "unread";

/**
 * Every word the viewer shows or says, so a product can put them in its own language. Words with a
 * number or a name in them are functions. Pass any of them to `labels`; the rest stay English.
 */
export interface ArtifactViewerLabels {
  // The file, and opening it.
  /** The name of a file with none of its own, in the toolbar and as the viewer's name. */
  file: string;
  /** The name a file is given when nothing names it: no name, and no URL to take one from. */
  untitled: string;
  /** While the file opens: "Opening plan.md", or "Opening the file" before its name is known. */
  opening: (name: string | undefined) => string;
  /** While an app is built for the first time (`building`): the stage's name, said to a screen reader. */
  building: string;
  /** The names on the building cursors' tags: the one that lays out, the one for data, the one for words. */
  builderLayout: string;
  builderData: string;
  builderCopy: string;
  /** The title when a file, or an image, did not open. */
  notOpened: string;
  /** Why it did not open: no answer at all. */
  didNotLoad: string;
  /** Why it did not open: the server answered with this status. */
  loadFailed: (status: number) => string;
  /** Why it did not open: none of `src`, `file` or `text` was given. */
  noSource: string;
  /** The title for a file of a kind the viewer does not draw. */
  unknownKind: string;
  /** The download button and menu item. */
  download: (name: string) => string;

  // The toolbar.
  /** The kind of file, after its name. */
  format: (format: ArtifactFormat) => string;
  /** A code file's language, by Prism's name for it (`"typescript"`). */
  language: (language: string) => string;
  /** Where you are: "Page 2 of 3", "Row 1 of 30", "Line 4 of 80". `at` counts from 1. */
  position: (kind: PositionKind, at: number, of: number) => string;
  /** Where you are, above the first heading. */
  start: string;
  /** The zoom: "Fit", or "125%". */
  zoom: (zoom: number | "fit") => string;
  previousSection: string;
  nextSection: string;
  zoomIn: string;
  zoomOut: string;
  zoomToFit: string;
  showOutline: string;
  hideOutline: string;
  /** The outline's landmark. */
  outline: string;
  /** The comments button: "Show comments, 3 open". */
  commentsButton: (open: boolean, count: number) => string;
  /** The preview and code switch, its two sides, and the menu's items for it. */
  view: string;
  preview: string;
  code: string;
  showCode: string;
  showPreview: string;
  more: string;
  /** The button, the menu item and the dialog's title. */
  shortcuts: string;
  /** Each shortcut, in the dialog and to the page's shortcut list. */
  shortcut: (action: ViewerAction) => string;

  // Find.
  /** The find field and the button that opens it. */
  find: string;
  noMatches: string;
  /** Which match of how many: "2 of 14", "2 of 500+" when there are more than were counted. */
  matchCount: (at: number, of: number, more: boolean) => string;
  previousMatch: string;
  nextMatch: string;
  commentOnMatch: string;
  closeFind: string;
  /** Under find, on a web page's preview. */
  findInPreview: string;

  // Comments.
  comments: string;
  showResolved: string;
  closeComments: string;
  yourComment: string;
  yourReply: string;
  /** The button that sends a new comment, and the selection bar's. */
  comment: string;
  /** The button that starts a reply, and the one that sends it. */
  reply: string;
  cancel: string;
  delete: string;
  resolve: string;
  reopen: string;
  /** A thread's words, pressed: shown in the file. */
  showInFile: string;
  /** A thread's name: who began it, if anyone, and the words it is on. */
  thread: (author: string | undefined, quote: string) => string;
  /** Over threads whose words have changed or gone. */
  changedOrGone: string;
  /** The panel with every thread resolved and hidden. */
  resolvedHidden: (count: number) => string;
  noComments: string;
  /** How long ago a comment was written, and the full date on hover. */
  ago: (date: Date) => string;
  date: (date: Date) => string;
  /** A cell's comment, when the cell has no words: its row's key and its column, from 1, or the column's name. */
  cellQuote: (
    row: string,
    column: number,
    header: string | undefined
  ) => string;
  /** A comment on a box on an image. */
  boxQuote: string;
  /** In the panel, on a web page's preview, and its button. */
  previewCannotMark: string;
  showItsCode: string;
  /** The bar by a selection, and its button. */
  selection: string;
  copyLink: string;
  /** Said to a screen reader. */
  commentsInCode: string;
  selectToComment: string;
  noCommentsToGo: string;
  /** Said on `]` and `[`: "Comment 2 of 5: the words". */
  commentAt: (at: number, of: number, quote: string) => string;
  linkCopied: string;
  linkNotCopied: string;
  commentAdded: string;
  replyAdded: string;
  resolved: string;
  reopened: string;

  // An agent's edits.
  /** The card by the words, and its heading. */
  proposedEdit: string;
  agentProposes: string;
  /** A proposal's heading in its thread. */
  agentProposesEdit: string;
  accept: string;
  reject: string;
  /** What the page's agent bridge asks the person before an agent's press on Accept. */
  acceptConfirm: string;
  outOfDate: string;
  accepted: string;
  rejected: string;
  /** Before words put in and words taken out, for a screen reader. */
  added: string;
  removed: string;
  /** The line after an edit, and its buttons. */
  editAccepted: string;
  agentChanged: string;
  editUndone: string;
  editRedone: string;
  undo: string;
  redo: string;
  done: string;
  /** Said to a screen reader. */
  undoHint: string;
  editRejected: string;
  staleSaid: string;
  nothingToUndo: string;
  nothingToRedo: string;
  cannotStep: (direction: "undo" | "redo") => string;
  /** Said as an agent proposes an edit. */
  proposalSaid: (target: ProposalTarget) => string;

  // A table.
  /** The toolbar's note: "3 rows not read cleanly". */
  rowsNotRead: (count: number) => string;
  emptyTable: string;
  emptyTableBody: string;
  /** The row numbers' column, for a screen reader. */
  row: string;
  noRows: string;

  // A PDF.
  /** A page: in the outline and as its name. */
  page: (page: number) => string;
  pdfFailure: (failure: PdfFailure) => { title: string; message: string };

  // A web page.
  /** The name of the button over a page that scrolls inside its frame: pressing it lets the page be used. */
  usePage: string;
  /** What shows at the frame's foot before it is pressed. */
  usePageHint: string;
  /** The control that gives the scroll back to what is round the frame. */
  usePageDone: string;
  pageLeft: string;
  pageLeftBody: (times: number) => string;

  // An image.
  imageFailed: string;
  showBoxComment: string;

  // Markdown.
  /** A task list's box: done, or not. */
  taskDone: string;
  taskNotDone: string;
}
