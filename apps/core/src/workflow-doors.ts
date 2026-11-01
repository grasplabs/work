import { doorSourcesOf } from "@grasp-os/open-workflow/diagram";
import type { DoorSource } from "@grasp-os/open-workflow/diagram";
import type {
  DiagramDoor,
  DiagramTask,
  WorkflowDiagram,
} from "@grasp-os/shared/workflow-diagrams";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import type { Acting } from "./auth/identity.ts";
import {
  triggerResources,
  triggerResourceVersions,
  workflowResources,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { listWorkflowResources } from "./workflow-resources.ts";

// The doors of a workflow's diagram (GRA-1254): the other workflows its
// tasks lead to, resolved for the reader. A `run` task's child workflow
// is the workflow of that name in this deployment; an `emit` task's event
// starts every workflow an enabled system trigger starts on that event
// contract and type. Threat model:
//
// - Naming a workflow the reader may not see. Each door names a workflow
//   only when the reader has a role in it, as the Workflows page lists
//   them (`listWorkflowResources`); any other door shows its flow alone,
//   with neither ID nor name, so a definition's literal text is all a
//   builder learns, and a reader of a run's trace learns nothing more.
// - Following "latest". Nothing here starts or binds anything: a door is
//   drawn from the definition and the triggers as they are now, never
//   from what a run was admitted with.
// - A diagram drawn before doors were. A task with no door keeps none,
//   and a diagram core didn't resolve has no `doors` at all.

const bindingsSchema = z.object({
  document: z.object({
    metadata: z.object({
      grasp: z.object({
        bindings: z.record(z.string(), z.object({ contract: z.string() })),
      }),
    }),
  }),
});

/** The contract key each binding of `definition` names, by alias. */
const contractsOf = (definition: unknown): ReadonlyMap<string, string> => {
  const parsed = bindingsSchema.safeParse(definition);
  if (!parsed.success) {
    return new Map();
  }
  return new Map(
    Object.entries(parsed.data.document.metadata.grasp.bindings).map(
      ([alias, { contract }]) => [alias, contract]
    )
  );
};

/** This deployment's workflows named `names`, by name. */
const workflowsNamed = async (
  env: Env,
  names: readonly string[]
): Promise<ReadonlyMap<string, string>> => {
  if (names.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select({ id: workflowResources.id, name: workflowResources.name })
    .from(workflowResources)
    .where(
      and(
        inList(workflowResources.name, names),
        isNull(workflowResources.deletedAt)
      )
    );
  return new Map(rows.map(({ id, name }) => [name, id]));
};

/** The workflows an enabled system trigger starts on each event, by `[contract, type]`. */
const workflowsStartedBy = async (
  env: Env,
  contracts: readonly string[]
): Promise<ReadonlyMap<string, string[]>> => {
  if (contracts.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select({
      contract: triggerResourceVersions.eventContract,
      type: triggerResourceVersions.eventType,
      workflowId: triggerResourceVersions.workflowResourceId,
    })
    .from(triggerResources)
    .innerJoin(
      triggerResourceVersions,
      and(
        eq(triggerResourceVersions.triggerId, triggerResources.id),
        eq(triggerResourceVersions.version, triggerResources.currentVersion)
      )
    )
    .innerJoin(
      workflowResources,
      eq(workflowResources.id, triggerResourceVersions.workflowResourceId)
    )
    .where(
      and(
        eq(triggerResources.kind, "system"),
        eq(triggerResources.enabled, true),
        isNull(triggerResources.deletedAt),
        isNull(workflowResources.deletedAt),
        inList(triggerResourceVersions.eventContract, contracts)
      )
    );
  const started = new Map<string, string[]>();
  for (const { contract, type, workflowId } of rows) {
    const key = JSON.stringify([contract, type]);
    const workflows = started.get(key) ?? [];
    if (!workflows.includes(workflowId)) {
      workflows.push(workflowId);
    }
    started.set(key, workflows);
  }
  return started;
};

/** Each task of `tasks` and the tasks its scopes hold, with `doors` set by pointer. */
const withDoorsAt = (
  tasks: readonly DiagramTask[],
  doors: ReadonlyMap<string, DiagramDoor[]>
): DiagramTask[] =>
  tasks.map((task) => {
    const own = doors.get(task.pointer);
    return {
      ...task,
      scopes: task.scopes.map((scope) => ({
        ...scope,
        tasks: withDoorsAt(scope.tasks, doors),
      })),
      ...(own === undefined ? {} : { doors: own }),
    };
  });

/**
 * `diagram`, drawn from `definition` (its parsed JSON), with each door
 * its tasks lead through resolved for `by`: a workflow's ID and name only
 * where they have a role in it.
 */
export const withDoors = async (
  env: Env,
  by: Acting,
  diagram: WorkflowDiagram,
  definition: unknown
): Promise<WorkflowDiagram> => {
  const sources = doorSourcesOf(z.json().parse(definition));
  if (sources.length === 0) {
    return diagram;
  }
  const contracts = contractsOf(definition);
  const eventKey = (source: DoorSource): string | undefined => {
    if (source.target.kind !== "event") {
      return undefined;
    }
    const contract = contracts.get(source.target.binding);
    return contract === undefined
      ? undefined
      : JSON.stringify([contract, source.target.type]);
  };
  const names = sources.flatMap(({ target }) =>
    target.kind === "workflow" &&
    (target.namespace === null || target.namespace === workflowNamespace)
      ? [target.name]
      : []
  );
  const [named, started, visible] = await Promise.all([
    workflowsNamed(env, [...new Set(names)]),
    workflowsStartedBy(env, [...new Set(contracts.values())]),
    listWorkflowResources(env, by),
  ]);
  const seen = new Map(visible.map(({ id, name }) => [id, name]));
  const doorOf = (flow: DiagramDoor["flow"], id: string): DiagramDoor => {
    const name = seen.get(id);
    return name === undefined
      ? { flow, workflowId: null, name: null }
      : { flow, workflowId: id, name };
  };
  const doors = new Map<string, DiagramDoor[]>();
  for (const source of sources) {
    const key = eventKey(source);
    const targets =
      source.target.kind === "workflow"
        ? [named.get(source.target.name)].filter((id) => id !== undefined)
        : (started.get(key ?? "") ?? []);
    doors.set(
      source.pointer,
      targets.map((id) => doorOf(source.flow, id))
    );
  }
  return { tasks: withDoorsAt(diagram.tasks, doors) };
};
