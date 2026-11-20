// The words the Artifact viewer shows and says, in English. The product gives them in its
// languages through GraspWords (src/words), as the catalogue's `artifactViewer`; a caller's
// `labels` still win until the breaking release's step 5. Words for an agent (its tools' answers and notes) are not
// here: they are for the model, not for a person.
import type { ArtifactFormat } from "./format";
import type { ViewerAction } from "./keys";
import type { ArtifactViewerLabels, PdfFailure, PositionKind } from "./types";

const FORMATS: Record<ArtifactFormat, string> = {
  markdown: "Markdown",
  code: "Code",
  text: "Text",
  image: "Image",
  pdf: "PDF",
  csv: "Table",
  html: "HTML",
  unknown: "File",
};

// Prism's language names, as people write them.
const LANGUAGES: Record<string, string> = {
  typescript: "TypeScript",
  tsx: "TSX",
  javascript: "JavaScript",
  jsx: "JSX",
  json: "JSON",
  css: "CSS",
  markup: "HTML",
  bash: "Shell",
  python: "Python",
  go: "Go",
  rust: "Rust",
  sql: "SQL",
  yaml: "YAML",
  markdown: "Markdown",
  java: "Java",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  ruby: "Ruby",
  kotlin: "Kotlin",
  swift: "Swift",
  diff: "Diff",
  toml: "TOML",
};

const POSITIONS: Record<PositionKind, string> = {
  page: "Page",
  row: "Row",
  line: "Line",
};

const SHORTCUTS: Record<ViewerAction, string> = {
  next: "Next section or page",
  previous: "Previous section or page",
  first: "To the start",
  last: "To the end",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  zoomReset: "Zoom to fit",
  find: "Find in the file",
  findNext: "Next match",
  findPrevious: "Previous match",
  view: "Switch between preview and code",
  outline: "Show or hide the outline",
  comment: "Comment on the selection, or on the match found",
  comments: "Show or hide the comments",
  nextComment: "Next comment",
  previousComment: "Previous comment",
  undo: "Undo the last edit",
  redo: "Redo the edit undone",
  close: "Close find and panels",
  help: "Show these shortcuts",
};

const PDF_FAILURES: Record<PdfFailure, { title: string; message: string }> = {
  locked: {
    title: "This PDF is locked",
    message:
      "It needs a password, so it cannot show here. Download it to open it.",
  },
  empty: {
    title: "This PDF has no pages",
    message:
      "There is nothing in it to show. Download it to check it in another app.",
  },
  invalid: {
    title: "This PDF did not open",
    message: "Its contents could not be read. Download it to try another app.",
  },
  unread: {
    title: "This PDF did not open",
    message:
      "Something in it could not be read. Download it to try another app.",
  },
};

const relative = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });
const full = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "long",
  timeStyle: "short",
});
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3600],
  ["minute", 60],
];

// How long ago, in words: "3 days ago".
const ago = (date: Date) => {
  const seconds = (date.getTime() - Date.now()) / 1000;
  const [unit, size] = STEPS.find(([, step]) => Math.abs(seconds) >= step) ?? [
    "second",
    1,
  ];
  return unit === "second"
    ? "just now"
    : relative.format(Math.round(seconds / size), unit);
};

export const englishLabels: ArtifactViewerLabels = {
  file: "File",
  untitled: "Untitled",
  opening: (name) => `Opening ${name ?? "the file"}`,
  building: "Building your app",
  builderLayout: "Layout",
  builderData: "Data",
  builderCopy: "Copy",
  notOpened: "It did not open",
  didNotLoad: "The file did not load.",
  loadFailed: (status) => `The file did not load (${status}).`,
  noSource: "Give the viewer a src, a file or a text.",
  unknownKind: "This kind of file does not show here",
  download: (name) => `Download ${name}`,

  format: (format) => FORMATS[format],
  language: (language) => LANGUAGES[language] ?? language,
  position: (kind, at, of) =>
    `${POSITIONS[kind]} ${at.toLocaleString()} of ${of.toLocaleString()}`,
  start: "Start",
  zoom: (zoom) => (zoom === "fit" ? "Fit" : `${zoom}%`),
  previousSection: "Previous section",
  nextSection: "Next section",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  zoomToFit: "Zoom to fit",
  showOutline: "Show the outline",
  hideOutline: "Hide the outline",
  outline: "Outline",
  commentsButton: (open, count) =>
    `${open ? "Hide" : "Show"} comments, ${count === 0 ? "none" : count} open`,
  view: "View",
  preview: "Preview",
  code: "Code",
  showCode: "Show the code",
  showPreview: "Show the preview",
  more: "More",
  shortcuts: "Keyboard shortcuts",
  shortcut: (action) => SHORTCUTS[action],

  find: "Find in the file",
  noMatches: "No matches",
  matchCount: (at, of, more) =>
    `${at.toLocaleString()} of ${of.toLocaleString()}${more ? "+" : ""}`,
  previousMatch: "Previous match",
  nextMatch: "Next match",
  commentOnMatch: "Comment on this match",
  closeFind: "Close find",
  findInPreview:
    "Counted in the page's words. Code view marks them in its source.",

  comments: "Comments",
  showResolved: "Show resolved",
  closeComments: "Close comments",
  yourComment: "Your comment",
  yourReply: "Your reply",
  comment: "Comment",
  reply: "Reply",
  cancel: "Cancel",
  delete: "Delete",
  resolve: "Resolve",
  reopen: "Reopen",
  showInFile: "Show in the file",
  thread: (author, quote) =>
    `${author === undefined ? "Comment" : `Comment by ${author}`} on "${quote.slice(0, 60)}"`,
  changedOrGone: "Its text has changed or gone",
  resolvedHidden: (count) =>
    `${count === 0 ? "None" : count} resolved, hidden.`,
  noComments: "No comments yet. Select some words and press C.",
  ago,
  date: (date) => full.format(date),
  cellQuote: (row, column, header) =>
    `Row ${row}, ${header ?? `column ${column}`}`,
  boxQuote: "A box on the image",
  previewCannotMark: "A web page's preview cannot be marked.",
  showItsCode: "Show its code",
  selection: "Selection",
  copyLink: "Copy link",
  commentsInCode: "Comments on a web page are made in Code view.",
  selectToComment: "Select some words, or find them, to comment on them.",
  noCommentsToGo: "No comments to go to.",
  commentAt: (at, of, quote) => `Comment ${at} of ${of}: ${quote.slice(0, 80)}`,
  linkCopied: "Link copied",
  linkNotCopied: "Could not copy",
  commentAdded: "Comment added.",
  replyAdded: "Reply added.",
  resolved: "Resolved.",
  reopened: "Reopened.",

  proposedEdit: "Proposed edit",
  agentProposes: "The agent proposes",
  agentProposesEdit: "The agent proposes an edit",
  accept: "Accept",
  reject: "Reject",
  acceptConfirm: "Accepts the agent's edit and changes the file",
  outOfDate: "Out of date: its words have changed.",
  accepted: "Accepted.",
  rejected: "Rejected.",
  added: "Added: ",
  removed: "Removed: ",
  editAccepted: "Edit accepted.",
  agentChanged: "The agent changed the file.",
  editUndone: "Edit undone.",
  editRedone: "Edit redone.",
  undo: "Undo",
  redo: "Redo",
  done: "Done",
  undoHint: "Undo with Ctrl or Command Z.",
  editRejected: "Edit rejected.",
  staleSaid:
    "This edit is out of date: its words have changed. It cannot be accepted.",
  nothingToUndo: "Nothing to undo.",
  nothingToRedo: "Nothing to redo.",
  cannotStep: (direction) =>
    `The text has changed there since, so this edit cannot be ${direction === "undo" ? "undone" : "redone"}.`,
  proposalSaid: (target) => {
    if (target.kind === "insert") {
      return "The agent proposes putting words in. Accept or Reject it.";
    }
    if (target.kind === "words") {
      return `The agent proposes an edit to "${target.words.slice(0, 60)}". Accept or Reject it.`;
    }
    return "The agent proposes an edit. Accept or Reject it.";
  },

  rowsNotRead: (count) =>
    `${count.toLocaleString()} ${count === 1 ? "row" : "rows"} not read cleanly`,
  emptyTable: "This table is empty",
  emptyTableBody: "The file has no rows and no columns.",
  row: "Row",
  noRows: "No rows under the head yet.",

  page: (page) => `Page ${page}`,
  pdfFailure: (failure) => PDF_FAILURES[failure],

  usePage: "Use the page",
  usePageHint: "Press to use the page",
  usePageDone: "Done",
  pageLeft: "This page kept leaving",
  pageLeftBody: (times) =>
    `It sent itself to another address ${times} times, so it is no longer shown. Its source is in Code view.`,

  imageFailed: "This image could not be drawn.",
  showBoxComment: "Show the comment on this part of the image",

  taskDone: "Done",
  taskNotDone: "Not done",
};

/** The labels a viewer uses: the product's, and English for any it leaves out. */
export const withEnglish = (
  labels: Partial<ArtifactViewerLabels> | undefined
): ArtifactViewerLabels => ({ ...englishLabels, ...labels });

/** The box's name before its file has one: the same word as `artifactViewer.file`, kept apart so the box, on the page at once, does not bring every word here with it. */
export const artifactViewerBoxWords = {
  file: "File",
};

/**
 * What the viewer tells an agent (its tools' answers) and a developer: they read English, so these
 * are kept here with the words and are not in the catalogue.
 */
export const artifactViewerNotices = {
  pageUnread: (page: number) =>
    `Page ${String(page)} has not been read yet: bring it into view, or try again in a moment.`,
  noThread: (id: string) => `No comment thread "${id}".`,
  notFound: (find: string) => `"${find}" is not in the file.`,
  wrongAnswer: (kind: string) =>
    `The viewer's ${kind} task answered with something else.`,
};

declare module "../words/words" {
  interface GraspWordsCatalog {
    artifactViewer: ArtifactViewerLabels;
    artifactViewerBox: typeof artifactViewerBoxWords;
  }
}
