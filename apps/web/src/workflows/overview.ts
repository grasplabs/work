import type { BusinessProcess } from "@grasp-os/shared/business-processes";
import type { CatalogEntry, ListedConnection } from "@grasp-os/shared/connect";
import type {
  WorkflowGoLiveWaiting,
  WorkflowStage,
} from "@grasp-os/shared/workflow-lifecycle";
import { liveStages } from "@grasp-os/shared/workflow-lifecycle";
import type { WorkflowResource } from "@grasp-os/shared/workflow-resources";
import type {
  ConnectionWorkflows,
  WorkflowSummary,
} from "@grasp-os/shared/workflows";

import {
  httpConnectionsOf,
  integrationsOf,
  workflowsOf,
} from "../connections/integrations.ts";
import { brandOf } from "../connections/provider-mark.tsx";
import type { CoreConnection } from "../core-connection.ts";
import type { Brand } from "../grasp/brand-icon/index.ts";
import { loadFromCore, orNull } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { listWorkflows, noneIfRefused } from "./reads.ts";

// What the Workflows page shows (workflows-table.tsx): every workflow the
// person has a role in, each in the phase it stands in, with the tools it
// reaches. Core keeps a workflow's stage on its lifecycle, one read a
// workflow; the overview's own read has no stage.

/**
 * The phases a workflow stands in, in the order the page reads them: what
 * needs the reader first. Core keeps nothing before a named workflow (a
 * sketch, a request for one), so the page has no phase for those.
 */
export const phases = ["needsYou", "running", "building", "toBuild"] as const;
export type Phase = (typeof phases)[number];

/**
 * The phase a workflow stands in. It needs the reader while a version of
 * it waits for them to let it go live, or runs of it wait for a decision
 * or failed lately. Otherwise it follows its stage: running once a version
 * went live through an approval, to build while it is only named, and
 * building in between, also when it already runs without that approval.
 */
export const phaseOf = (workflow: {
  stage: WorkflowStage;
  waitsToGoLive: boolean;
  waiting: number;
  failed: number;
}): Phase => {
  if (workflow.waitsToGoLive || workflow.waiting > 0 || workflow.failed > 0) {
    return "needsYou";
  }
  if (liveStages.includes(workflow.stage)) {
    return "running";
  }
  return workflow.stage === "mapped" ? "toBuild" : "building";
};

/** One workflow on the page. */
export interface OverviewRow {
  id: string;
  name: string;
  phase: Phase;
  /** Whether someone paused it: it starts no runs. */
  paused: boolean;
  /** The business process it serves, if a builder set one. */
  process: BusinessProcess | null;
  /** Its owner's name, where core knows it. */
  owner: string | null;
  /** The runs it completed this week; null before its first run. */
  runs: number | null;
}

/** A workflow core listed for the person, with where its lifecycle stands. */
interface ListedWorkflow {
  summary: WorkflowSummary;
  stage: WorkflowStage;
  paused: boolean;
}

/**
 * The page's rows, by phase and within one as core listed them (by name):
 * every workflow the person has a role in, and any other whose version
 * waits for them to let it go live (an admin's, of which core gives the
 * name alone).
 */
const overviewRows = ({
  listed,
  goLives,
  resources,
}: {
  listed: readonly ListedWorkflow[];
  goLives: readonly WorkflowGoLiveWaiting[];
  /** The workflows' own records, for the process each serves; none read without them. */
  resources: readonly WorkflowResource[];
}): OverviewRow[] => {
  const waiting = new Set(goLives.map(({ workflowId }) => workflowId));
  const processes = new Map(resources.map(({ id, process }) => [id, process]));
  const own = listed.map(({ summary, stage, paused }): OverviewRow => ({
    id: summary.workflowId,
    name: summary.name,
    phase: phaseOf({
      stage,
      waitsToGoLive: waiting.has(summary.workflowId),
      waiting: summary.waiting,
      failed: summary.failed,
    }),
    paused,
    process: processes.get(summary.workflowId) ?? null,
    owner: summary.owner.name,
    runs: summary.lastRun === null ? null : summary.handled,
  }));
  const known = new Set(own.map(({ id }) => id));
  const others = new Map(
    goLives
      .filter(({ workflowId }) => !known.has(workflowId))
      .map(({ workflowId, name }): [string, OverviewRow] => [
        workflowId,
        {
          id: workflowId,
          name,
          phase: "needsYou",
          paused: false,
          process: processes.get(workflowId) ?? null,
          owner: null,
          runs: null,
        },
      ])
  );
  return [...own, ...others.values()].toSorted(
    (one, other) => phases.indexOf(one.phase) - phases.indexOf(other.phase)
  );
};

/** A tool a workflow reaches: an app by its name, with the library's mark where it has one. */
export interface Tool {
  name: string;
  brand: Brand | undefined;
}

/** The tools each workflow reaches, by the workflow's ID. */
export type ToolsByWorkflow = ReadonlyMap<string, readonly Tool[]>;

/**
 * The tools each workflow reaches: the apps whose connections its current
 * version uses (`workflows.byConnection`), each once, and its HTTP
 * connections by their names.
 */
const toolsByWorkflow = (
  uses: readonly ConnectionWorkflows[],
  connections: readonly ListedConnection[],
  entries: readonly (CatalogEntry & { offered: boolean })[]
): ToolsByWorkflow => {
  const tools = new Map<string, Tool[]>();
  const add = (workflow: string, tool: Tool): void => {
    tools.set(workflow, [...(tools.get(workflow) ?? []), tool]);
  };
  for (const integration of integrationsOf(entries, connections)) {
    const tool = {
      name: integration.name,
      brand: brandOf(integration.id, integration.name),
    };
    for (const workflow of workflowsOf(integration, uses)) {
      add(workflow.id, tool);
    }
  }
  for (const { connection, http } of httpConnectionsOf(connections)) {
    const used = uses.find(
      ({ connectionId }) => connectionId === connection.id
    );
    for (const workflow of used?.workflows ?? []) {
      add(workflow.id, { name: http.name, brand: undefined });
    }
  }
  return tools;
};

/**
 * Reads the page's rows: the workflows core lists for the person, each
 * one's lifecycle for its stage, and the versions waiting for the person
 * to let them go live. The process each serves is read beside them, and
 * left out if it can't be.
 */
export const readOverview = async (
  core: Pick<CoreConnection, "withSession">
): Promise<Loaded<OverviewRow[]>> =>
  await loadFromCore(core, async (session) => {
    const [workflows, goLives, resources] = await Promise.all([
      listWorkflows(session),
      noneIfRefused(session.workflowResources.lifecycle.waiting()),
      orNull(async () => await session.workflowResources.list()),
    ]);
    const listed = await Promise.all(
      workflows.map(async (summary): Promise<ListedWorkflow> => {
        const lifecycle = await session.workflowResources.lifecycle.get(
          summary.workflowId
        );
        return {
          summary,
          stage: lifecycle.stage,
          paused: lifecycle.paused !== null,
        };
      })
    );
    return overviewRows({ listed, goLives, resources: resources ?? [] });
  });

/**
 * Reads the tools each workflow reaches. They stand beside a workflow, so
 * a read of them that fails leaves the page without them, never without
 * its workflows.
 */
export const readTools = async (
  core: Pick<CoreConnection, "withSession">
): Promise<ToolsByWorkflow> => {
  const read = await loadFromCore(core, async (session) => {
    const [uses, connections, catalog] = await Promise.all([
      session.workflows.byConnection(),
      session.connections.list(),
      // The catalog names an app; without it, its provider's ID stands in.
      orNull(async () => await session.connections.catalog()),
    ]);
    return toolsByWorkflow(uses, connections, catalog?.entries ?? []);
  });
  return read.state === "ready" ? read.data : new Map();
};
