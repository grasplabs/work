import type {
  BoardReport,
  BoardReportPart,
  SignalCount,
} from "@grasp-os/shared/dashboard";
import { isExpectedError } from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import { canBuild, isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";

import type { AppsRpc } from "./apps-rpc.ts";
import type { KnowledgeSignalsRpc } from "./knowledge/signals-rpc.ts";
import type { OnboardingRpc } from "./onboarding/rpc.ts";
import type { SignalsRpc } from "./signals-rpc.ts";
import type { WorkflowsRpc } from "./workflows/rpc.ts";

// The board's weekly report, read in one call (`dashboard.report()`). It
// keeps nothing of its own: each part is read through the namespace the
// person reaches it by anyway, with that namespace's checks, so the report
// says nothing they couldn't read already, and a part one refuses them is
// left out rather than failed. The week it is about is core's own count
// (onboarding/cadence.ts), the same the dashboard's line and bar show.

/** The namespaces the report is read from: the session's own. */
export interface BoardReportSources {
  onboarding: OnboardingRpc;
  workflows: WorkflowsRpc;
  signals: SignalsRpc;
  knowledgeSignals: KnowledgeSignalsRpc;
  apps: AppsRpc;
}

/** Whether core refused `error` to the person's role: theirs to see none of, not a failure. */
const refusedToRole = (error: unknown): boolean =>
  roleErrors.codeOf(error) === "role.forbidden";

/** `read`, or none when the person's role may not read it. */
const orNone = async <T>(read: Promise<T>): Promise<T | undefined> => {
  try {
    return await read;
  } catch (error) {
    if (refusedToRole(error)) {
      return undefined;
    }
    throw error;
  }
};

/**
 * Reads one part. A part that fails leaves the rest: the report says it
 * couldn't be read, with the code when the failure is one a caller may see.
 */
const partOf = async <T>(
  part: string,
  read: () => Promise<T>
): Promise<BoardReportPart<T>> => {
  try {
    return { state: "read", data: await read() };
  } catch (error) {
    if (isExpectedError(error)) {
      return { state: "unread", code: error.code };
    }
    log.error("board_report.part_failed", { part, ...errorFields(error) });
    return { state: "unread", code: "internal.unexpected" };
  }
};

/**
 * How many signals of each kind the person reads: every improvement
 * signal for admins, each engine's they build for builders (an engine
 * whose signals core refuses them left out), and their own collections'.
 * Null when they read none.
 */
const signalCounts = async (
  { signals, knowledgeSignals, apps }: BoardReportSources,
  person: Identity
): Promise<SignalCount[] | null> => {
  const improvement = async () => {
    if (isAdmin(person.role)) {
      const all = await orNone(signals.list());
      return all === undefined ? [] : [all];
    }
    if (!canBuild(person.role)) {
      return [];
    }
    const engines = (await orNone(apps.list())) ?? [];
    const each = await Promise.all(
      engines.map(async ({ id }) => await orNone(signals.list({ app: id })))
    );
    return each.filter((read) => read !== undefined);
  };
  const [improved, knowledge] = await Promise.all([
    improvement(),
    orNone(knowledgeSignals.list()),
  ]);
  if (improved.length === 0 && knowledge === undefined) {
    return null;
  }
  const counts = new Map<SignalCount["kind"], number>();
  const kinds = [
    ...improved.flatMap(({ signals: listed }) => listed),
    ...(knowledge?.signals ?? []),
  ].map(({ kind }) => kind);
  for (const kind of kinds) {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts].map(([kind, count]) => ({ kind, count }));
};

/** The board's weekly report, for `person`, as it stands now. */

/** A workflow's key in a report: an App's by App and name, an independent one by its ID. */
const reportKeyOf = (
  workflow:
    | { type: "app"; app: string; workflow: string }
    | { type: "resource"; workflowId: string }
): string =>
  workflow.type === "app"
    ? `${workflow.app}/${workflow.workflow}`
    : workflow.workflowId;

export const boardReportOf = async (
  sources: BoardReportSources,
  person: Identity
): Promise<BoardReport> => {
  const { onboarding, workflows } = sources;
  const programme = await partOf(
    "programme",
    async () => await onboarding.programme()
  );
  // The report's window once the programme is known; without one, the
  // days run activity counts by default.
  const window =
    programme.state === "read" && programme.data !== null
      ? programme.data.reportWindow
      : undefined;
  const runs = partOf("runs", async () => await workflows.activity(window));
  const [ran, better, people] = await Promise.all([
    runs,
    partOf("signals", async () => await signalCounts(sources, person)),
    isAdmin(person.role)
      ? partOf("people", async () => {
          const { progress } = await onboarding.view();
          return progress;
        })
      : undefined,
  ]);
  const idleWorkflows = await partOf("workflows", async () => {
    const listed = (await orNone(workflows.overview())) ?? [];
    const ranNames = new Set(
      ran.state === "read" ? ran.data.workflows.map(reportKeyOf) : []
    );
    return listed.filter((workflow) => !ranNames.has(reportKeyOf(workflow)))
      .length;
  });
  return {
    programme,
    runs: ran,
    idleWorkflows,
    better,
    ...(people === undefined ? {} : { people }),
  };
};
