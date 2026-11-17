// What a step of agent activity is, shared by its parts (agent-activity.tsx, step.tsx).
import type { IconData } from "../icons";

/** What kind of step: reasoning, a tool, a file read or changed, or a search. */
export type ActivityKind = "thought" | "tool" | "read" | "write" | "search";

/** Where a step is. */
export type ActivityState =
  | "waiting"
  | "working"
  | "done"
  | "failed"
  | "skipped";

/** One step the agent takes. */
export interface ActivityStep {
  /** Its own id, steady while it moves through its states. */
  id: string;
  /** What kind of step; it picks how the one line counts it. */
  kind: ActivityKind;
  /** What it does, in a few words, as it reads when done ("Read brief.md", "Searched the web"). */
  title: string;
  /** The same, as it reads while it works ("Reading brief.md"). Leave it out to use the title. */
  active?: string;
  /** Where it is. */
  state: ActivityState;
  /** A quiet note after the title: a tool's name, a count ("12 results"). */
  summary?: string;
  /**
   * How many things it touched, when it knows: the sources a search found, the files it read or
   * changed. The one line adds them up ("Found 12 sources"); without it a step counts as one, and
   * a search as a search ("Searched 3 times").
   */
  count?: number;
  /** What went in: a tool's input, a search's words. Shown when the step is opened. */
  input?: string;
  /** What came back, or why it failed. Shown when the step is opened; cut to six lines until "Show more". */
  result?: string;
  /** How long it took, in milliseconds. */
  duration?: number;
  /** An icon of its own, in place of the trail's dot. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
}

/** Every word agent activity writes itself, so the product can say them in its own language. */
export interface AgentActivityWords {
  /** A step's state, said to a screen reader after its title. */
  states: Record<ActivityState, string>;
  /** The press under long output, closed and open. */
  showMore: string;
  showLess: string;
  /** The labels over a step's input and result; `error` in place of `result` when it failed. */
  input: string;
  result: string;
  error: string;
  /** What a screen reader hears when a step fails ("Read brief.md failed"). */
  stepFailed: (title: string) => string;
  /** The one line counted from the steps, when no `summary` is given. */
  summarize: (steps: ActivityStep[]) => string;
}
