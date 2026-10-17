import { descriptorFromText } from "@grasp-os/sdk/host";
import type {
  AppManifest,
  BoundWorkflowDecision,
  WorkflowBindingExtras,
} from "@grasp-os/sdk/host";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { boundEventsOf } from "./bound-workflow-events.ts";
import type { PinnedEventBinding } from "./bound-workflow-events.ts";
import {
  appWorkflowBindings,
  sdkResourceBindings,
  workflowResourceVersions,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { resolveCatalogKeys } from "./workflow-catalog.ts";
import type { ResolvedCatalogContract } from "./workflow-catalog.ts";

// What the host resolves of the workflows an App declares, for the
// references it generates (`generateModules`, `WorkflowBindingExtras`):
// each declared alias's active binding (app-workflow-bindings.ts), the
// exact workflow version it pins, and that version's decision bindings,
// each read from the catalog contract the version pinned by fingerprint
// (workflow-catalog.ts), and its event bindings and listen tasks the same
// way, as browser references (bound-workflow-events.ts).
//
// Only the builders' view counts: a binding is written by a builder of
// the App with a role in the workflow, a version's bindings at its
// publication, a catalog contract by an admin, and never anything App
// code says. A seal resolves them once and seals what it resolved in the
// release's contracts (app-releases.ts), so a binding changed after the
// seal changes no sealed release; a draft resolves them as they are now.

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
 * What the host resolves of each workflow `manifest` declares that `app`
 * binds now: its alias, and its pinned version's decisions and the events
 * a screen sends, by their binding's alias, with the listen tasks waiting
 * on those events. A declared alias with no active binding, and a binding
 * the App's code doesn't declare, resolve to nothing.
 */
export const boundWorkflowsOf = async (
  env: Env,
  app: AppId,
  manifest: AppManifest
): Promise<WorkflowBindingExtras[]> => {
  if (Object.keys(manifest.workflows).length === 0) {
    return [];
  }
  const db = drizzle(env.DB);
  const active = await db
    .select({
      alias: appWorkflowBindings.alias,
      workflow: appWorkflowBindings.workflowResourceId,
      version: appWorkflowBindings.workflowResourceVersion,
    })
    .from(appWorkflowBindings)
    .where(
      and(
        eq(appWorkflowBindings.appId, app),
        eq(appWorkflowBindings.status, "active")
      )
    )
    .orderBy(asc(appWorkflowBindings.alias));
  const bindings = active.filter(({ alias }) =>
    Object.hasOwn(manifest.workflows, alias)
  );
  if (bindings.length === 0) {
    return [];
  }
  const pinned = await db
    .select({
      workflow: sdkResourceBindings.resourceId,
      version: sdkResourceBindings.resourceVersion,
      alias: sdkResourceBindings.alias,
      kind: sdkResourceBindings.kind,
      contractId: sdkResourceBindings.contractId,
      fingerprint: sdkResourceBindings.schemaHash,
    })
    .from(sdkResourceBindings)
    .where(
      and(
        inList(sdkResourceBindings.kind, ["decision", "event"]),
        // Every pinned version as one bound parameter: D1 binds at most 100
        // to a statement, and an App may bind more workflows than that.
        sql`EXISTS (SELECT 1 FROM json_each(${JSON.stringify(
          bindings.map(({ workflow, version }) => [workflow, version])
        )}) AS pin
          WHERE json_extract(pin.value, '$[0]') = ${sdkResourceBindings.resourceId}
            AND json_extract(pin.value, '$[1]') = ${sdkResourceBindings.resourceVersion})`
      )
    )
    .orderBy(asc(sdkResourceBindings.alias));
  const contracts = await resolveCatalogKeys(env, [
    ...new Set(pinned.flatMap(({ contractId }) => contractId ?? [])),
  ]);
  return await Promise.all(
    bindings.map(async ({ alias, workflow, version }) => {
      const decisions: Record<string, BoundWorkflowDecision> = {};
      const eventBindings: PinnedEventBinding[] = [];
      for (const row of pinned) {
        if (
          row.workflow !== workflow ||
          row.version !== version ||
          !aliasPattern.test(row.alias)
        ) {
          continue;
        }
        const contract = contracts.get(row.contractId ?? "");
        if (row.kind === "event") {
          const bound = eventBindingOf(row.alias, contract, row.fingerprint);
          if (bound === undefined) {
            log.warn("app.workflow_event_unresolved", {
              appId: app,
              alias,
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
            log.warn("app.workflow_decision_unresolved", {
              appId: app,
              alias,
              decision: row.alias,
            });
          } else {
            decisions[row.alias] = decision;
          }
        } catch (error) {
          // Published through the catalog's own reader, so a descriptor it
          // took and this one refuses is the platform's error, never the
          // App's.
          log.error("app.workflow_decision_unreadable", {
            appId: app,
            alias,
            decision: row.alias,
            ...errorFields(error),
          });
        }
      }
      if (eventBindings.length === 0) {
        return { alias, events: {}, listens: {}, decisions };
      }
      try {
        const { events, listens } = boundEventsOf(
          eventBindings,
          await recordedListens(env, workflow, version)
        );
        return { alias, events, listens, decisions };
      } catch (error) {
        // Corrupt data (a contract the catalog refuses, a version whose
        // stored contract no longer hashes): no events rather than no seal.
        log.error("app.workflow_events_unreadable", {
          appId: app,
          alias,
          ...errorFields(error),
        });
        return { alias, events: {}, listens: {}, decisions };
      }
    })
  );
};
