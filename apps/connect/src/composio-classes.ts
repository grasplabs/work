import type { ToolClass } from "@grasp-os/shared/connect";

// The class of each Composio tool Grasp reviewed, by toolkit slug and tool
// name, as this release ships it: given once, for every company. Composio
// changes a toolkit without a release of ours, and its own hints
// (`readOnlyHint` and the like) are best-effort, so they may suggest a
// class in a review but never set one. A tool nobody classed is never
// offered and never run, whatever an admin allowed (connections.ts), and
// one classed `never` is a tool reviewed and turned down.
//
// A toolkit's table is the input to its review page, kept outside the
// repo; a toolkit comes in here once its review is done. Connect reads it
// as `#composio-classes` (package.json), so its tests and core's can class
// the tools of their fake Composio instead (test/fixtures/composio-classes.ts).

/** Each reviewed tool's class, by toolkit, then by the tool's name. */
export type ComposioClasses = Readonly<
  Record<string, Readonly<Record<string, ToolClass>>>
>;

export const composioClasses: ComposioClasses = {};
