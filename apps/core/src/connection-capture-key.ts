import type { ConnectionOwner } from "@grasp-os/shared/connect";

import { captureGroupOf } from "./brain-next-origins.ts";
import { nativeItemReads } from "./native-tool-classes.gen.ts";

// The key of a source captured from a connection (GRA-1730,
// connection-capture.ts): its connection, then a hash that names one item
// for its person, in its connection's group (brain-next-origins.ts
// `captureGroupOf`), so disconnecting it erases them all in one call
// (GRA-1827). The Brain knows no connector: to it, this is one producer's
// id like any other.

/** A connection, as capture and its erasure read whose it is. */
type Owned = Pick<ConnectionOwner, "source" | "provider" | "ownerUserId">;

/**
 * Whether captures may have been kept through `connection` for
 * `personId`, by this release or an earlier one: their own native
 * connection, to any provider. What disconnecting it erases by, so a
 * provider an earlier release kept reads from, and this one doesn't (a
 * rollback), still has its captures erased.
 */
export const mayHoldCapturesOf = (
  connection: Owned,
  personId: string
): boolean =>
  connection.source === "native" && connection.ownerUserId === personId;

/**
 * Whether the Brain keeps what agents read through `connection` for
 * `personId` (connection-capture.ts): their own native connection, to a
 * provider with a tool that answers one item's content
 * (`nativeItemReads`). Capture keeps only such reads, and the Brain page
 * and the disconnect dialog say so by it.
 */
export const keepsReadsOf = (connection: Owned, personId: string): boolean =>
  mayHoldCapturesOf(connection, personId) &&
  Object.hasOwn(nativeItemReads, connection.provider);

const encoder = new TextEncoder();

const sha256Hex = async (text: string): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(text))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/**
 * The id the item `itemId` (as its connector names it) read by the tool
 * `action` through `connectionId` is kept under for `personId`:
 * `<connection>/<hash>`, in the connection's group (`captureGroupOf`). The same tool reading the item again makes its
 * next version. The hash covers the tool, as tools read an item in
 * different ways (a list's summary, a full read): one never replaces what
 * another kept. It covers the person, so no two people's reads share a
 * source. An outside ID is hashed, never put in a key as it is, so none
 * reaches another kind's keys or lengthens it. (A connection ID too long
 * for a source's id is refused by core's Brain module, as any producer's
 * id is.)
 */
export const captureIdOf = async (
  connectionId: string,
  personId: string,
  action: string,
  itemId: string
): Promise<string> =>
  `${captureGroupOf(connectionId).id}/${await sha256Hex(JSON.stringify([personId, action, itemId]))}`;
