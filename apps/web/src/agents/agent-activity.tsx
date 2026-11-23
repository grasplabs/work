import { AgentIndicator } from "@grasp-os/ui/components/agent-indicator";
import { Text } from "@grasp-os/ui/components/text";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@grasp-os/ui/components/trace";
import type { TraceLineStatus } from "@grasp-os/ui/components/trace";
import { Icon } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { formatList } from "../format.ts";

// What an agent did on its way to an answer, summed up in one line that
// opens on its steps: in a chat, over the answer it led to, and on a
// workflow's run, over what each step of it asked. On Damsko's Trace: the
// line is its collapsible trigger, the steps its lines, each with its own
// mark and what went in and came back. While the agent works the line
// says so beside Damsko's agent indicator; once it is done, it counts
// what the steps did ("Found 12 sources and read 2 files"). Moved here
// from the old library with the agents' other parts.

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
  kind: ActivityKind;
  /** What it does, as it reads when done ("Read brief.md"). */
  title: string;
  /** The same, as it reads while it works ("Reading brief.md"); the title when left out. */
  active?: string;
  state: ActivityState;
  /** A quiet note after the title: a tool's name, a count ("12 results"). */
  summary?: string;
  /** How many things it touched: the sources a search found, the files it read or changed. */
  count?: number;
  /** What went in: a tool's input, a search's words. */
  input?: string;
  /** What came back, or why it failed. */
  result?: string;
  /** An icon of its own, in place of the line's dot. */
  icon?: IconData;
}

const styles = stylex.create({
  // What went in and came back, under a step's title.
  detail: { display: "grid", gap: space["1"] },
});

/** The trace's mark for a step's state. */
const statusOf = (state: ActivityState): TraceLineStatus | undefined => {
  if (state === "working") {
    return "running";
  }
  if (state === "failed") {
    return "error";
  }
  return state === "waiting" ? "pending" : undefined;
};

/** The order kinds are counted in, the one line's. */
const countedFirst: readonly ActivityKind[] = [
  "search",
  "read",
  "write",
  "tool",
  "thought",
];

/**
 * The one line counted from the steps that ran: what each kind came to,
 * then how many failed. A step counts as one thing unless it says how many
 * it touched; a search with no count is counted as a search.
 */
export const useActivitySummary = () => {
  const { t } = useLingui();
  const counted = (kind: ActivityKind, steps: ActivityStep[]): string => {
    const touched = steps.reduce(
      (sum, step) => sum + (step.count ?? (kind === "search" ? 0 : 1)),
      0
    );
    if (kind === "search" && steps.every(({ count }) => count === undefined)) {
      const searches = steps.length;
      return plural(searches, {
        one: "searched once",
        other: "searched # times",
      });
    }
    const byKind: Record<ActivityKind, () => string> = {
      search: () =>
        plural(touched, {
          0: "found no sources",
          one: "found # source",
          other: "found # sources",
        }),
      read: () =>
        plural(touched, { one: "read # file", other: "read # files" }),
      write: () =>
        plural(touched, { one: "changed # file", other: "changed # files" }),
      tool: () => plural(touched, { one: "ran # tool", other: "ran # tools" }),
      thought: () => t`thought it through`,
    };
    return byKind[kind]();
  };
  return (steps: readonly ActivityStep[]): string => {
    const ran = steps.filter(
      ({ state }) => state === "done" || state === "failed"
    );
    const parts = countedFirst
      .map((kind) => ({ kind, of: ran.filter((step) => step.kind === kind) }))
      .filter(({ of }) => of.length > 0)
      .map(({ kind, of }) => counted(kind, of));
    if (parts.length === 0) {
      return t`No steps yet`;
    }
    const list = formatList(parts);
    const done = `${list.charAt(0).toLocaleUpperCase()}${list.slice(1)}`;
    const failed = steps.filter(({ state }) => state === "failed").length;
    return failed === 0
      ? done
      : plural(failed, {
          one: `${done}; # step failed`,
          other: `${done}; # steps failed`,
        });
  };
};

/** One step: its mark, its title as it reads now, and what went in and came back. */
const Step = ({ step }: { step: ActivityStep }) => {
  const { t } = useLingui();
  const title =
    step.state === "working" ? (step.active ?? step.title) : step.title;
  const { input, result } = step;
  const opens = input !== undefined || result !== undefined;
  return (
    <TraceLine status={statusOf(step.state)}>
      <TraceIcon>
        {step.icon === undefined ? null : <Icon icon={step.icon} />}
      </TraceIcon>
      <TraceTitle>{title}</TraceTitle>
      {step.summary === undefined && !opens ? null : (
        <TraceDescription>
          <span {...stylex.props(styles.detail)}>
            {step.summary ?? null}
            {input === undefined ? null : (
              <Text as="span" color="muted" size="sm">
                {t`Input: ${input}`}
              </Text>
            )}
            {result === undefined ? null : (
              <Text as="span" color="muted" size="sm">
                {step.state === "failed"
                  ? t`Why it failed: ${result}`
                  : t`Result: ${result}`}
              </Text>
            )}
          </span>
        </TraceDescription>
      )}
    </TraceLine>
  );
};

/** What the agent did: one line, opened on its steps. */
export const AgentActivity = ({
  steps,
  working,
  workingLabel,
  summary,
  defaultOpen = false,
}: {
  steps: readonly ActivityStep[];
  /** Whether the run goes on: the line says `workingLabel` beside the indicator. */
  working: boolean;
  /** What it is doing, while it works ("Reading your files…"). */
  workingLabel?: string;
  /** The line once done, in place of the counted one. */
  summary?: string;
  defaultOpen?: boolean;
}) => {
  const { t } = useLingui();
  const summarize = useActivitySummary();
  const line = working
    ? (workingLabel ?? t`Working`)
    : (summary ?? summarize(steps));
  return (
    <Trace>
      <TraceCollapsible defaultOpen={defaultOpen} disabled={steps.length === 0}>
        <TraceCollapsibleTrigger>
          <TraceLine status={working ? "running" : undefined}>
            {working ? (
              <TraceIcon>
                <AgentIndicator />
              </TraceIcon>
            ) : null}
            <TraceTitle>{line}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {steps.map((step) => (
              <Step key={step.id} step={step} />
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
};
