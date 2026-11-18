import { syncPageSchema, syncPlacesSchema } from "@grasp-os/shared/sync";
import type { SyncItemKind, SyncPage } from "@grasp-os/shared/sync";
import { z } from "zod";

import { ToolError } from "./connector.ts";
import {
  syncManifestSchema,
  syncNameSchema,
  syncParamsSchema,
  syncPlacesParamsSchema,
} from "./manifest.ts";
import type { Route, SyncManifest } from "./manifest.ts";

// How a native connector reads a source for native sync (GRA-1758): one
// page of what changed from a cursor, as neutral items. A sync isn't a
// tool: no agent, App or workflow can call it. Connect alone asks for a
// page, by its own method on the connector's server (`syncMethod`), and
// runs it like a tool's call, in a fresh isolate whose only way out is the
// egress, which adds the token and lets through only the sync's routes.
// A route's `{place}` path parameter is bound to the place asked for.

/** Why a page couldn't be read, as the connector says it. */
export const syncFailureSchema = z.strictObject({
  code: z.enum(["restart", "throttled", "inactive", "failed"]),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
});
export type SyncFailure = z.infer<typeof syncFailureSchema>;

/** A connector's answer to `syncMethod`: a page, or why there is none. */
export const syncResultSchema = z.union([
  z.strictObject({ page: syncPageSchema }),
  z.strictObject({ failure: syncFailureSchema }),
]);
export type SyncResult = z.infer<typeof syncResultSchema>;

/** A connector's answer to `syncPlacesMethod`: places, or why there are none. */
export const syncPlacesResultSchema = z.union([
  syncPlacesSchema,
  z.strictObject({ failure: syncFailureSchema }),
]);
export type SyncPlacesResult = z.infer<typeof syncPlacesResultSchema>;

/**
 * Thrown by a sync's `read` when the provider no longer has the cursor (a
 * 404 or 410 on it): the source is listed again from the start.
 */
export class RestartSyncError extends Error {
  constructor(message = "The provider no longer has the cursor") {
    super(message);
    this.name = "RestartSyncError";
  }
}

export interface SyncDefinition {
  /** The sync's name, as core asks for it. */
  name: string;
  /** The kind of item it reads. */
  kind: SyncItemKind;
  /** The only requests it may send: GETs. */
  routes: readonly Route[];
  /**
   * One page from `cursor` on (from the start when null): what is there or
   * changed, and what went away, with the cursor to read on from. Only
   * what `place` holds: for `own`, only what the connection's own account
   * owns. A page stays within what connect reads of a connector's answer.
   */
  read: (params: { place: string; cursor: string | null }) => Promise<SyncPage>;
  /**
   * The places of the connection's own account it reads, each a source of
   * its own with its own cursor (a mailbox's folders): none for a sync that
   * reads the whole account (`own`). A place it doesn't read any more is
   * left out; core then drops its source.
   */
  places?: () => Promise<readonly string[]>;
}

/** A sync, as a connector carries it. */
export interface Sync {
  name: string;
  manifest: SyncManifest;
  /** Answers `syncMethod`'s params with a page or a failure. */
  call: (params: unknown) => Promise<SyncResult>;
  /** Answers `syncPlacesMethod`'s params with places or a failure. */
  places: (params: unknown) => Promise<SyncPlacesResult>;
}

/** The failure an error a sync threw stands for. */
const failureOf = (error: unknown): SyncFailure => {
  if (error instanceof RestartSyncError) {
    return { code: "restart" };
  }
  if (!(error instanceof ToolError) || error.details === undefined) {
    return { code: "failed" };
  }
  const { code, retryAfterSeconds } = error.details;
  if (code === "throttled" || code === "unavailable") {
    return retryAfterSeconds === undefined
      ? { code: "throttled" }
      : { code: "throttled", retryAfterSeconds };
  }
  return code === "access_denied" ? { code: "inactive" } : { code: "failed" };
};

/** A sync, from its definition. */
export const defineSync = (definition: SyncDefinition): Sync => ({
  name: syncNameSchema.parse(definition.name),
  manifest: syncManifestSchema.parse({
    kind: definition.kind,
    places: definition.places === undefined ? "own" : "listed",
    routes: definition.routes,
  }),
  places: async (params) => {
    syncPlacesParamsSchema.parse(params);
    if (definition.places === undefined) {
      return { failure: { code: "failed" } };
    }
    let places: unknown;
    try {
      places = { places: await definition.places() };
    } catch (error) {
      return { failure: failureOf(error) };
    }
    // A list with one place that isn't one is refused whole.
    const parsed = syncPlacesSchema.safeParse(places);
    return parsed.success ? parsed.data : { failure: { code: "failed" } };
  },
  call: async (params) => {
    const asked = syncParamsSchema.parse(params);
    let page: unknown;
    try {
      page = await definition.read({
        place: asked.place,
        cursor: asked.cursor,
      });
    } catch (error) {
      return { failure: failureOf(error) };
    }
    const parsed = syncPageSchema.safeParse(page);
    return parsed.success
      ? { page: parsed.data }
      : { failure: { code: "failed" } };
  },
});
