import type { BusinessProcess } from "@grasp-os/shared/business-processes";
import type { CatalogEntry, ListedConnection } from "@grasp-os/shared/connect";
import { workflowLabel } from "@grasp-os/shared/workflow-resources";
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
import { listWorkflows } from "./reads.ts";

// What the Workflows page shows (workflows-table.tsx): every workflow the
// person has a role in, each in the phase it stands in, with the tools it
// reaches. What is published is what runs, so a workflow runs once a
// version of it is live (`version`); whether it is paused is on its own
// record.

/**
 * The phases a workflow stands in, in the order the page reads them: what
 * needs the reader first.
 */
export const phases = ["needsYou", "running", "building"] as const;
export type Phase = (typeof phases)[number];

/**
 * The phase a workflow stands in. It needs the reader while runs of it
 * wait for a decision or failed lately. Otherwise it runs once a version
 * of it is live, and is being built before.
 */
export const phaseOf = (workflow: {
  live: boolean;
  waiting: number;
  failed: number;
}): Phase => {
  if (workflow.waiting > 0 || workflow.failed > 0) {
    return "needsYou";
  }
  return workflow.live ? "running" : "building";
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
        }),
        paused: record?.paused ?? false,
        process: record?.process ?? null,
        owner: summary.owner.name,
        runs: summary.lastRun === null ? null : summary.handled,
      };
    })
    .toSorted(
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
