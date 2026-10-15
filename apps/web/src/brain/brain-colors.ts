import { groupOf } from "./brain.ts";
import type { Group, NoteKind } from "./brain.ts";

/**
 * The colour of each kind of note, one soft hue per group from the `--graph-*` tokens, for the
 * file tree, note pages and the atlas's panel: a dot, and a soft fill for chips. Gaps are hollow in
 * a teal of their own, and applications nobody named hollow too, like unresolved links in Obsidian.
 */
const groupDot: Record<Group, string> = {
  company: "bg-foreground",
  vision: "bg-graph-vision",
  teams: "bg-graph-teams",
  tools: "bg-graph-tools",
  statements: "bg-graph-statements",
  candidates: "bg-graph-candidates",
  gaps: "border border-graph-gaps",
  sources: "bg-graph-sources",
};

export const dotClass = (kind: NoteKind): string =>
  kind === "app" ? "border border-graph-tools" : groupDot[groupOf[kind]];

/** The same hue as a soft fill, for chips and labels on a note page, so a name shows what it is before it is read. */
const groupTint: Record<Group, string> = {
  company: "bg-muted hover:bg-sidebar-accent",
  vision: "bg-graph-vision/15 hover:bg-graph-vision/25",
  teams: "bg-graph-teams/15 hover:bg-graph-teams/25",
  tools: "bg-graph-tools/15 hover:bg-graph-tools/25",
  statements: "bg-graph-statements/20 hover:bg-graph-statements/30",
  candidates: "bg-graph-candidates/15 hover:bg-graph-candidates/25",
  gaps: "bg-graph-gaps/15 hover:bg-graph-gaps/25",
  sources: "bg-graph-sources/30 hover:bg-graph-sources/45",
};

export const tintClass = (kind: NoteKind): string => groupTint[groupOf[kind]];
