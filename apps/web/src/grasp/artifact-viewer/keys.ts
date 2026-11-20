// The viewer's keyboard shortcuts, in one list: the shell registers them, the `?` dialog shows
// them, and every one also has a named control in the toolbar or its menu. What each does, in
// words, is a label (`shortcut`, labels.ts).

export type ViewerAction =
  | "next"
  | "previous"
  | "first"
  | "last"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "find"
  | "findNext"
  | "findPrevious"
  | "close"
  | "help"
  | "view"
  | "comment"
  | "comments"
  | "nextComment"
  | "previousComment"
  | "outline"
  | "undo"
  | "redo";

export interface ViewerKey {
  action: ViewerAction;
  keys: string[];
  /** Only while comments are on. */
  comments?: boolean;
  /** Only while edits are on (the viewer is given `onEdit`). */
  edits?: boolean;
}

export const VIEWER_KEYS: readonly ViewerKey[] = [
  { action: "next", keys: ["j"] },
  { action: "previous", keys: ["k"] },
  { action: "first", keys: ["home"] },
  { action: "last", keys: ["end"] },
  { action: "zoomIn", keys: ["="] },
  { action: "zoomOut", keys: ["-"] },
  { action: "zoomReset", keys: ["0"] },
  { action: "find", keys: ["mod+f", "/"] },
  { action: "findNext", keys: ["mod+g"] },
  { action: "findPrevious", keys: ["shift+mod+g"] },
  { action: "view", keys: ["v"] },
  { action: "outline", keys: ["o"] },
  { action: "comment", keys: ["c"], comments: true },
  { action: "comments", keys: ["shift+c"], comments: true },
  { action: "nextComment", keys: ["]"], comments: true },
  { action: "previousComment", keys: ["["], comments: true },
  { action: "undo", keys: ["mod+z"], edits: true },
  { action: "redo", keys: ["shift+mod+z"], edits: true },
  { action: "close", keys: ["escape"] },
  { action: "help", keys: ["shift+?"] },
];

/** The zoom steps, in percent. */
export const ZOOMS = [
  50, 67, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300,
] as const;

export const zoomStep = (
  from: number | "fit",
  direction: 1 | -1,
  fitAt = 100
): number => {
  const now = from === "fit" ? fitAt : from;
  if (direction > 0) {
    return ZOOMS.find((step) => step > now) ?? ZOOMS.at(-1) ?? now;
  }
  return ZOOMS.findLast((step) => step < now) ?? ZOOMS[0];
};
