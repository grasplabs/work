import type { AppDefinition } from "@grasp-os/runtime/definition";
import { declaredPermission, descriptorFromText } from "@grasp-os/runtime/host";
import type {
  AppManifest,
  BoundWorkflowDecision,
  WorkflowBindingExtras,
  WorkflowEventContract,
} from "@grasp-os/runtime/host";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { boundEventsOf } from "./bound-workflow-events.ts";
import type { PinnedEventBinding } from "./bound-workflow-events.ts";
import {
  sdkResourceBindings,
  workflowResourceVersions,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { resolveCatalogKeys } from "./workflow-catalog.ts";
import type { ResolvedCatalogContract } from "./workflow-catalog.ts";

// What the host resolves of the workflows an App declares. A release
// seals the workflow each declared alias is bound to once its version is
// current (`sealedWorkflowBindings`, app-workflow-bindings.ts): what its
// pages start, at the workflow's live version, and whose runs they read,
// each at the version it is of. The events, listen
// tasks and decisions the App's references name are the App's own
// declaration (`permission.workflow`), never resolved from the binding.
//
// What a version has of them (`versionEventContract`) is read for binding
// it: each decision binding read from the catalog contract the version
// pinned by fingerprint (workflow-catalog.ts), and its event bindings and
// listen tasks the same way, as browser references
// (bound-workflow-events.ts). Binding a version that doesn't give what
// the App declares is refused (app-workflow-bindings.ts), so what a page
// names a run takes.
//
// Only the builders' view counts: a binding is written by a builder of
// the App with a role in the workflow, a version's bindings at its
// publication, a catalog contract by an admin, and never anything App
// code says.

/** What the App's generated references name: plain identifiers. */
const aliasPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/**
 * The decision `contract` describes for a version that pinned it with
 * `fingerprint`; undefined when the catalog no longer holds that exact
 * contract, or it isn't a decision's, so no reference names a shape no
 * one approved.
 */
const decisionOf = (
  contract: ResolvedCatalogContract | undefined,
  fingerprint: string
): BoundWorkflowDecision | undefined => {
  if (
    contract === undefined ||
    contract.kind !== "decision" ||
    contract.fingerprint !== fingerprint ||
    contract.contract.input === undefined ||
    contract.contract.response === undefined
  ) {
    return undefined;
  }
  return {
    value: descriptorFromText(contract.contract.response),
    context: descriptorFromText(contract.contract.input),
  };
};

/** The listen tasks a version's stored contract records (workflow-resources.ts). */
const recordedListensSchema = z.object({
  listens: z.record(
    z.string(),
    z.strictObject({ alias: z.string(), types: z.array(z.string()) })
  ),
});

/**
 * The listen tasks version `version` of workflow `workflow` records, read
 * from its stored contract checked against its hash, as a start reads it
 * (workflow-resources.ts, `versionContract`); none for no such version.
 * Throws for a contract that no longer hashes.
 */
const recordedListens = async (
  env: Env,
  workflow: string,
  version: number
): Promise<z.infer<typeof recordedListensSchema>["listens"]> => {
  const row = await drizzle(env.DB)
    .select({
      contract: workflowResourceVersions.contract,
      contractHash: workflowResourceVersions.contractHash,
    })
    .from(workflowResourceVersions)
    .where(
      and(
        eq(workflowResourceVersions.workflowResourceId, workflow),
        eq(workflowResourceVersions.version, version)
      )
    )
    .get();
  if (row === undefined) {
    return {};
  }
  if ((await sha256Hex(row.contract)) !== row.contractHash) {
    throw new Error(`Version ${version} of ${workflow}'s contract is corrupt.`);
  }
  return recordedListensSchema.parse(JSON.parse(row.contract)).listens;
};

/**
 * The event binding `contract` describes for a version that pinned it
 * with `fingerprint`, as `alias`; undefined as for a decision.
 */
const eventBindingOf = (
  alias: string,
  contract: ResolvedCatalogContract | undefined,
  fingerprint: string
): PinnedEventBinding | undefined =>
  contract === undefined ||
  contract.kind !== "event" ||
  contract.fingerprint !== fingerprint ||
  contract.contract.events === undefined
    ? undefined
    : { alias, events: contract.contract.events };

/**
 * What `versionEventContract` read of a version: its contract, and
 * whether all of it read (`complete`).
 */
export interface VersionEventContract extends WorkflowEventContract {
  readonly complete: boolean;
}

/**
 * The events, listen tasks and decisions version `version` of workflow
 * `workflow` has, as a page may send and answer them: its decisions and
 * its browser-callable events by their binding's alias, with the listen
 * tasks waiting on those events. One its pinned catalog contract no
 * longer resolves is left out, logged; corrupt data (a contract the
 * catalog refuses, a stored contract that no longer hashes) leaves its
 * events out, logged too, so it differs from any declaration naming them.
 * Either makes it not `complete`.
 */
export const versionEventContract = async (
  env: Env,
  workflow: string,
  version: number
): Promise<VersionEventContract> => {
  const pinned = await drizzle(env.DB)
    .select({
      alias: sdkResourceBindings.alias,
      kind: sdkResourceBindings.kind,
      contractId: sdkResourceBindings.contractId,
      fingerprint: sdkResourceBindings.schemaHash,
    })
    .from(sdkResourceBindings)
    .where(
      and(
        eq(sdkResourceBindings.resourceId, workflow),
        eq(sdkResourceBindings.resourceVersion, version),
        inList(sdkResourceBindings.kind, ["decision", "event"])
      )
    )
    .orderBy(asc(sdkResourceBindings.alias));
  const contracts = await resolveCatalogKeys(env, [
    ...new Set(pinned.flatMap(({ contractId }) => contractId ?? [])),
  ]);
  const decisions: Record<string, BoundWorkflowDecision> = {};
  const eventBindings: PinnedEventBinding[] = [];
  let complete = true;
  for (const row of pinned) {
    if (!aliasPattern.test(row.alias)) {
      // No reference can name it: the App can't declare it.
      complete = false;
      continue;
    }
    const contract = contracts.get(row.contractId ?? "");
    if (row.kind === "event") {
      const bound = eventBindingOf(row.alias, contract, row.fingerprint);
      if (bound === undefined) {
        complete = false;
        log.warn("app.workflow_event_unresolved", {
          workflowId: workflow,
          version,
          event: row.alias,
        });
      } else {
        eventBindings.push(bound);
      }
      continue;
    }
    try {
      const decision = decisionOf(contract, row.fingerprint);
      if (decision === undefined) {
        complete = false;
        log.warn("app.workflow_decision_unresolved", {
          workflowId: workflow,
          version,
          decision: row.alias,
        });
      } else {
        decisions[row.alias] = decision;
      }
    } catch (error) {
      // Published through the catalog's own reader, so a descriptor it
      // took and this one refuses is the platform's error, never the App's.
      complete = false;
      log.error("app.workflow_decision_unreadable", {
        workflowId: workflow,
        version,
        decision: row.alias,
        ...errorFields(error),
      });
    }
  }
  if (eventBindings.length === 0) {
    return { events: {}, listens: {}, decisions, complete };
  }
  try {
    const { events, listens } = boundEventsOf(
      eventBindings,
      await recordedListens(env, workflow, version)
    );
    return { events, listens, decisions, complete };
  } catch (error) {
    log.error("app.workflow_events_unreadable", {
      workflowId: workflow,
      version,
      ...errorFields(error),
    });
    return { events: {}, listens: {}, decisions, complete: false };
  }
};

/**
 * The workflow each workflow `manifest` declares is bound to once the
 * version whose definition is `definition` is current, by alias, for its
 * seal: what the definition records (`workflowBindings`, written by the
 * draft's `bindWorkflow`). A declared alias it binds nothing under, and a
 * binding the App's code doesn't declare, resolve to nothing. A claim
 * until the version is made current, which checks each again
 * (app-workflow-bindings.ts, `versionBindingChanges`).
 */
export const sealedWorkflowBindings = (
  manifest: AppManifest,
  definition: AppDefinition
): WorkflowBindingExtras[] =>
  (definition.workflowBindings ?? [])
    .filter(
      ({ alias }) =>
        declaredPermission(manifest, alias, "workflows") !== undefined
    )
    .toSorted((a, b) => (a.alias < b.alias ? -1 : 1))
    .map(({ alias, workflowId }) => ({ alias, workflowId }));
