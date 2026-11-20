// The Artifact viewer's comments and editing, as a slot the core holds and two items fill
// (`artifact-viewer-comments`, `artifact-viewer-editing`). Without them the viewer shows no comment
// panel and takes no edit: `comments`, `onComment` and `onEdit` do nothing. An item registers its
// hook when it is imported; the hook loads with the viewer's lazy shell, before any viewer draws, so
// the hook a viewer calls never changes.
import type { ReactNode, RefObject } from "react";

import type { ProposeInput } from "./agent";
import type { Anchor, CellAnchor, TableShape, TextAnchor } from "./anchor";
import type { EditPatch } from "./edits";
import type { ArtifactFormat } from "./format";
import type {
  ArtifactViewerLabels,
  CommentAuthor,
  CommentThread,
  DrawnNote,
  RendererControl,
} from "./types";

/** What a comment holds on to in this view. */
export type AnchorKind = "text" | "pdf" | "cell" | "rect" | "none";

export const anchorKindOf = (
  format: ArtifactFormat | undefined
): AnchorKind => {
  if (format === "markdown" || format === "code" || format === "text") {
    return "text";
  }
  if (format === "pdf") {
    return "pdf";
  }
  if (format === "csv") {
    return "cell";
  }
  if (format === "image") {
    return "rect";
  }
  return "none";
};

/** A thread as the panel lists it: where it is now, if anywhere. */
export interface PlacedThread {
  thread: CommentThread;
  /** The words it holds on to (or a cell's text, or "A box on the image"). */
  quote: string;
  /** Its order in the file; null when orphaned. */
  order: number[] | null;
}

/** A thread where it is now in the file: its words' place, when it has one. */
export type PlacedNote = PlacedThread & {
  part: number;
  start: number;
  end: number;
  row: number;
  column: number;
  pending: boolean;
};

export interface CommentsOptions {
  viewer: string;
  threads: readonly CommentThread[] | undefined;
  author?: CommentAuthor;
  /** May give back the new thread's id (or a promise of it), so the viewer can open it. */
  onComment?: (anchor: Anchor, body: string) => unknown;
  onReply?: (threadId: string, body: string) => void;
  onResolve?: (threadId: string, resolved: boolean) => void;
  onDelete?: (threadId: string, itemId: string) => void;
  /** The view: what anchors are made of here, and whether a web page's preview shows. */
  kind: AnchorKind;
  preview: boolean;
  /** The source text (text formats), each page's text (PDF), the table's shape. */
  source: string | undefined;
  pages: readonly (string | undefined)[];
  table: TableShape | null;
  rowOf: ((part: number, offset: number) => number) | null;
  scroller: HTMLElement | null;
  root: RefObject<HTMLDivElement | null>;
  control: RefObject<RendererControl | null>;
  /** The open thread and the shared place, kept in the link by the shell. */
  active: string | null;
  setActive: (id: string | null, how: "push" | "replace") => void;
  /** The place the link named as the viewer opened: selected once. */
  initialLinked: string | undefined;
  setLinked: (code: string | undefined) => void;
  findOpen: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** For a web page's preview: switch to its source, where comments show. */
  onShowCode?: () => void;
  /** Says words to a screen reader, through the viewer's one live region. */
  say: (words: string) => void;
  /** What a thread shows under its comments: an agent's proposed edit. */
  threadExtra?: (threadId: string) => ReactNode;
  /** At the top of the panel: proposed edits on no thread. */
  panelExtra?: ReactNode;
  /** The words it shows and says. */
  labels: ArtifactViewerLabels;
}

/** What the comments item gives the viewer. */
export interface CommentsApi {
  on: boolean;
  panel: ReactNode;
  floating: ReactNode;
  placed: PlacedNote[];
  notes: readonly DrawnNote[];
  count: number;
  wantedParts: number[];
  commentHere: () => void;
  startDraft: (anchor: Anchor) => void;
  openThread: (id: string, how?: "push" | "replace") => void;
  next: () => void;
  previous: () => void;
}

/** A proposed edit, as the viewer keeps it. */
export interface Proposal {
  id: string;
  threadId?: string;
  anchor: TextAnchor | CellAnchor;
  replacement: string;
  note?: string;
  status: "pending" | "accepted" | "rejected";
  /** For a cell: its value when the edit was proposed. A different value now means out of date. */
  value?: string;
}

/** Who may apply an agent's edit: the person, by Accept (the default), or the agent itself. */
export type AgentEdits = "propose" | "apply";

export interface EditsOptions {
  viewer: string;
  onEdit?: (patch: EditPatch) => void;
  mode: AgentEdits;
  kind: AnchorKind;
  source: string | undefined;
  table: TableShape | null;
  threads: readonly CommentThread[] | undefined;
  scroller: HTMLElement | null;
  root: RefObject<HTMLDivElement | null>;
  say: (words: string) => void;
  /** A web page shown as its preview: a proposal is on its source, shown in Code view. */
  preview?: boolean;
  /** The words it shows and says. */
  labels: ArtifactViewerLabels;
}

/** A proposal's place now: its range in the source, or null when its words have gone (stale). */
export interface Placed {
  proposal: Proposal;
  range: { start: number; end: number } | null;
  before: string;
}

/** What the editing item gives the viewer. */
export interface EditsApi {
  on: boolean;
  proposals: Placed[];
  propose: (input: ProposeInput) => unknown;
  accept: (id: string, reason?: "accept" | "apply") => unknown;
  reject: (id: string) => void;
  choose: (id: string | null) => void;
  undo: () => void;
  redo: () => void;
  reset: () => void;
  card: ReactNode;
  bar: ReactNode;
  forThread: (threadId: string) => ReactNode;
  loose: ReactNode;
  cellProposals: { id: string; anchor: CellAnchor; replacement: string }[];
}

const NONE: readonly never[] = [];
const idle = () => {
  // Nothing to do without the item.
};

/** No comments item: no panel, no threads. */
const useNoComments = (_options: CommentsOptions): CommentsApi => ({
  on: false,
  panel: null,
  floating: null,
  placed: [],
  notes: NONE,
  count: 0,
  wantedParts: [],
  commentHere: idle,
  startDraft: idle,
  openThread: idle,
  next: idle,
  previous: idle,
});

/** No editing item: no proposals, nothing to undo. */
const useNoEdits = (_options: EditsOptions): EditsApi => ({
  on: false,
  proposals: [],
  propose: () => ({
    error: "This viewer takes no edits: its editing item is not installed.",
  }),
  accept: idle,
  reject: idle,
  choose: idle,
  undo: idle,
  redo: idle,
  reset: idle,
  card: null,
  bar: null,
  forThread: () => null,
  loose: null,
  cellProposals: [],
});

/** The hooks a viewer calls: the items' once they are imported, else none. */
export const viewerExtras = {
  useComments: useNoComments,
  useEdits: useNoEdits,
};

// The items' hooks, waiting to load: with the viewer's own lazy shell, never before, so a page
// pays for comments and editing only once a viewer starts to draw.
const waiting: (() => Promise<void>)[] = [];

/** The comments item's hook, loaded with the viewer's shell: the item registers it when imported. */
export const registerComments = (
  load: () => Promise<(options: CommentsOptions) => CommentsApi>
) => {
  waiting.push(async () => {
    viewerExtras.useComments = await load();
  });
};

/** The editing item's hook, loaded with the viewer's shell: the item registers it when imported. */
export const registerEdits = (
  load: () => Promise<(options: EditsOptions) => EditsApi>
) => {
  waiting.push(async () => {
    viewerExtras.useEdits = await load();
  });
};

/** Loads every registered item's hook: the shell waits for them, so its first draw has them. */
export const loadExtras = async () => {
  await Promise.all(
    waiting.splice(0).map(async (load) => {
      await load();
    })
  );
};
