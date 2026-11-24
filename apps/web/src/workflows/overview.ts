import type { BusinessProcess } from "@grasp-os/shared/business-processes";
import type { MemberRole } from "@grasp-os/shared/subject-members";
import { workflowLabel } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResource } from "@grasp-os/shared/workflow-resources";
import type {
  TriggerKind,
  WorkflowTrigger,
} from "@grasp-os/shared/workflow-triggers";
import type { WorkflowSummary } from "@grasp-os/shared/workflows";

import type { CoreConnection } from "../core-connection.ts";
import { timeoutMs, withTimeout } from "../core.ts";
import { loadFromCore, orNull } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { listWorkflows } from "./reads.ts";

// What the Workflows page shows (workflow-rows.tsx): every workflow the
// person has a role in, each in the phase it stands in. What is published is what runs, so a workflow runs once a
// version of it is live (`version`); whether it is paused is on its own
// record.

/**
 * The phases a workflow stands in, in the order the page reads them: what
 * needs the reader first.
 */
const phases = ["needsYou", "running", "building"] as const;
export type Phase = (typeof phases)[number];

/**
 * The phase a workflow stands in. It needs the reader while runs of it
 * wait for a decision or failed lately, or, for an admin, while its
 * trigger waits for an admin to allow it. Otherwise it runs once a version
 * of it is live, unless it is paused or its triggers can't start it; it
 * doesn't run before ("building", said "Not running").
 */
export const phaseOf = (workflow: {
  live: boolean;
  waiting: number;
  failed: number;
  paused?: boolean;
  /** Why its triggers can't start it (`TriggerBlock`), if they can't. */
  blocked?: TriggerBlock["why"] | null;
  /** Whether the reader is an admin, who allows a trigger. */
  admin?: boolean;
}): Phase => {
  const { blocked = null, paused = false } = workflow;
  if (workflow.waiting > 0 || workflow.failed > 0) {
    return "needsYou";
  }
  // Only a trigger waiting for one is an admin's to allow: a refused or
  // stopped one waits on its builders.
  if (blocked === "waiting" && workflow.admin === true && !paused) {
    return "needsYou";
  }
  return workflow.live && !paused && blocked === null ? "running" : "building";
};

/**
 * Why a workflow's triggers start nothing: the first of them waits for an
 * admin to allow it, or an admin refused it (`why`), by its kind.
 */
export interface TriggerBlock {
  kind: TriggerKind;
  why: "waiting" | "refused";
}

/** One workflow on the page. */
export interface OverviewRow {
  id: string;
  name: string;
  phase: Phase;
  /** Whether someone paused it: it starts no runs. */
  paused: boolean;
  /**
   * Why its triggers start nothing, when it has triggers and none of them
   * can start it; null otherwise, and while they aren't read.
   */
  blocked: TriggerBlock | null;
  /** The reader's role in it: a user sees only their own runs. Null where its record wasn't read. */
  role: MemberRole | null;
  /** The business process it serves, if a builder set one. */
  process: BusinessProcess | null;
  /** Its owner's name, where core knows it. */
  owner: string | null;
  /** The runs it completed this week; null before its first run. */
  runs: number | null;
  /** The version new runs run; null before the first is published. */
  version: number | null;
  /** Its runs waiting for a decision now. */
  waiting: number;
  /** Its runs that failed lately. */
  failed: number;
  /** When its latest run began; null before its first. */
  lastRun: string | null;
}

/**
 * How a workflow stands, as its row's mark says it: what it needs of the
 * reader first (a failure before a decision), then that someone paused it,
 * then whether a version of it runs.
 */
export const states = [
  "failing",
  "waiting",
  "paused",
  "blocked",
  "live",
  "building",
] as const;
export type WorkflowState = (typeof states)[number];

/**
 * How a workflow stands: live only where something can start it, so a
 * live version whose triggers can't start it is `blocked`.
 */
export const stateOf = (
  row: Pick<
    OverviewRow,
    "failed" | "waiting" | "paused" | "version" | "blocked"
  >
): WorkflowState => {
  if (row.failed > 0) {
    return "failing";
  }
  if (row.waiting > 0) {
    return "waiting";
  }
  if (row.paused) {
    return "paused";
  }
  if (row.version === null) {
    return "building";
  }
  return row.blocked === null ? "live" : "blocked";
};

/**
 * The page's rows, by phase and within one as core listed them (by name):
 * every workflow the person has a role in, each by the name people see
 * (`workflowLabel`).
 */
const overviewRows = ({
  listed,
  resources,
}: {
  listed: readonly WorkflowSummary[];
  /** The workflows' own records, for the process each serves and whether it is paused; none read without them. */
  resources: readonly WorkflowResource[];
}): OverviewRow[] => {
  const records = new Map(resources.map((each) => [each.id, each]));
  return listed
    .map((summary): OverviewRow => {
      const record = records.get(summary.workflowId);
      return {
        id: summary.workflowId,
        name: workflowLabel(summary),
        phase: phaseOf({
          live: summary.version !== null,
          waiting: summary.waiting,
          failed: summary.failed,
          paused: record?.paused ?? false,
        }),
        paused: record?.paused ?? false,
        blocked: null,
        role: record?.role ?? null,
        process: record?.process ?? null,
        owner: summary.owner.name,
        runs: summary.lastRun === null ? null : summary.handled,
        version: summary.version,
        waiting: summary.waiting,
        failed: summary.failed,
        lastRun: summary.lastRun?.createdAt ?? null,
      };
    })
    .toSorted(
      (one, other) => phases.indexOf(one.phase) - phases.indexOf(other.phase)
    );
};

/**
 * Reads the page's rows: the workflows core lists for the person, and
 * their records beside them, for the process each serves and whether it
 * is paused, left out if they can't be read.
 */
export const readOverview = async (
  core: Pick<CoreConnection, "withSession">
): Promise<Loaded<OverviewRow[]>> =>
  await loadFromCore(core, async (session) => {
    const [listed, resources] = await Promise.all([
      listWorkflows(session),
      orNull(async () => await session.workflowResources.list()),
    ]);
    return overviewRows({ listed, resources: resources ?? [] });
  });

/** What starts a workflow's runs, as its row's route begins. */
export interface RowTrigger {
  kind: TriggerKind;
  /** An email trigger's address, the part before the `@`; null for any other kind. */
  address: string | null;
  /** When a schedule trigger next starts a run; null for any other kind. */
  nextAt: string | null;
  /**
   * Why it starts nothing, if it can't: it waits for an admin to allow it,
   * or an admin refused it; null when it can start its workflow.
   */
  blocked: TriggerBlock["why"] | null;
}

/** What starts each workflow, by the workflow's ID: its enabled triggers, oldest first. */
export type TriggersByWorkflow = ReadonlyMap<string, readonly RowTrigger[]>;

/**
 * Why a trigger starts nothing (`RowTrigger.blocked`): a permission it
 * needs (its start on its workflow, a connection trigger's events too)
 * waits for an admin or was never asked for, or was refused or taken back;
 * a schedule that stopped, a deleted source, or one holding no start (it
 * asks for none, so no request waits), as refused: no admin allowing
 * anything makes it start. Null when it can start.
 */
const blockOf = ({
  start,
  events,
  stopped,
  source,
}: WorkflowTrigger): TriggerBlock["why"] | null => {
  const needs = events === null ? [start] : [start, events];
  if (stopped || source?.deleted === true || start === null) {
    return "refused";
  }
  if (needs.some((status) => status === "revoked")) {
    return "refused";
  }
  return needs.every((status) => status === "active") ? null : "waiting";
};

const rowTrigger = (trigger: WorkflowTrigger): RowTrigger => ({
  kind: trigger.kind,
  address: trigger.address,
  nextAt: trigger.nextAt,
  blocked: blockOf(trigger),
});

/**
 * Why a workflow whose enabled triggers are `own` starts nothing: when it
 * has some and none of them can start it, by the first that waits for an
 * admin (allowing it would start the workflow), else by the first; null
 * otherwise.
 */
const blockOfRows = (own: readonly RowTrigger[]): TriggerBlock | null => {
  if (own.length === 0 || own.some(({ blocked }) => blocked === null)) {
    return null;
  }
  const named = own.find(({ blocked }) => blocked === "waiting") ?? own[0];
  return named === undefined || named.blocked === null
    ? null
    : { kind: named.kind, why: named.blocked };
};

/** Why a workflow with `triggers` (all it has) starts nothing (`blockOfRows`). */
export const workflowBlock = (
  triggers: readonly WorkflowTrigger[]
): TriggerBlock | null =>
  blockOfRows(triggers.filter(({ enabled }) => enabled).map(rowTrigger));

/**
 * `rows` as their triggers leave them: a live workflow with triggers none
 * of which can start it is blocked (by the first, as its row names it),
 * and stands in the phase that says so (`phaseOf`), needing an admin
 * reading it. Rows whose triggers weren't read stand as they were.
 */
export const withTriggers = (
  rows: readonly OverviewRow[],
  triggers: TriggersByWorkflow,
  admin: boolean
): OverviewRow[] =>
  rows
    .map((row): OverviewRow => {
      const blocked = blockOfRows(triggers.get(row.id) ?? []);
      return {
        ...row,
        blocked,
        phase: phaseOf({
          live: row.version !== null,
          waiting: row.waiting,
          failed: row.failed,
          paused: row.paused,
          blocked: blocked?.why ?? null,
          admin,
        }),
      };
    })
    .toSorted(
      (one, other) => phases.indexOf(one.phase) - phases.indexOf(other.phase)
    );

/**
 * Reads what starts each of `workflows`. Core lists a workflow's triggers
 * one workflow at a time, so this is a read each, side by side; one that
 * can't be read leaves its row without them.
 */
export const readTriggers = async (
  core: Pick<CoreConnection, "withSession">,
  workflows: readonly string[]
): Promise<TriggersByWorkflow> => {
  const read = await loadFromCore(
    core,
    async (session) =>
      await Promise.all(
        workflows.map(
          async (id) =>
            [
              id,
              // Half a page's limit each: one slow read leaves its row
              // unread rather than holding the page.
              await orNull(
                async () =>
                  await withTimeout(
                    session.workflowResources.triggers.list(id),
                    timeoutMs / 2
                  )
              ),
            ] as const
        )
      )
  );
  if (read.state !== "ready") {
    return new Map();
  }
  // A workflow whose triggers core didn't list to the reader has no entry:
  // what starts it is unknown, never "by hand".
  return new Map(
    read.data.flatMap(([id, triggers]) =>
      triggers === null
        ? []
        : [[id, triggers.filter(({ enabled }) => enabled).map(rowTrigger)]]
    )
  );
};
