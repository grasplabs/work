import { syncPageSchema } from "@grasp-os/shared/sync";
import type { SyncItemKind, SyncPage } from "@grasp-os/shared/sync";
import { z } from "zod";

import { ToolError } from "./connector.ts";
import { maxContentBytes } from "./content.ts";
import {
  connectorIsolateRequests,
  syncManifestSchema,
  syncNameSchema,
  syncParamsSchema,
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

/**
 * What one page may take, so it fits what connect gives a connector's
 * isolate and reads of its answer:
 *
 * - `requests`: every request a connector's isolate may send
 *   (`connectorIsolateRequests`, which connect's isolate is loaded with).
 *   Nothing else in a sync's isolate sends any.
 * - `contentBytes`: its items' content together, as JSON, the same bound a
 *   tool's file read has (`maxContentBytes`, half of the 16 MiB connect
 *   reads, for the rest of the page). A file larger than a tool reads
 *   (`maxReadBytes`) comes without content.
 * - `millis`: how long after it started a page stops taking more, half of
 *   the 30 s connect waits for a connector's answer (`callTimeoutMs`), the
 *   rest for loading the isolate and answering. A request still under way
 *   then is given up, so a page always answers in time with what it has.
 */
export const syncPageLimits = {
  requests: connectorIsolateRequests,
  contentBytes: maxContentBytes,
  millis: 15_000,
} as const;

/** A connector's answer to `syncMethod`: a page, or why there is none. */
export const syncResultSchema = z.union([
  z.strictObject({ page: syncPageSchema }),
  z.strictObject({ failure: syncFailureSchema }),
]);
export type SyncResult = z.infer<typeof syncResultSchema>;

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
  read: (params: {
    place: string;
    cursor: string | null;
    /** When the page stops taking more, in ms since the epoch (`syncPageLimits.millis`). */
    deadline: number;
  }) => Promise<SyncPage>;
}

/** A sync, as a connector carries it. */
export interface Sync {
  name: string;
  manifest: SyncManifest;
  /** Answers `syncMethod`'s params with a page or a failure. */
  call: (params: unknown) => Promise<SyncResult>;
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
    routes: definition.routes,
  }),
  call: async (params) => {
    const asked = syncParamsSchema.parse(params);
    let page: unknown;
    try {
      page = await definition.read({
        place: asked.place,
        cursor: asked.cursor,
        deadline: Date.now() + syncPageLimits.millis,
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
