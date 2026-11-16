import type {
  ConnectionOwner,
  ConnectionSource,
} from "@grasp-os/shared/connect";
import { canonicalText } from "@grasp-os/shared/json";

import { captureGroupOf } from "./brain-next-origins.ts";

// The key of a source captured from a connection (GRA-1730,
// connection-capture.ts): its connection, then a hash that names one item
// for its person, or one call's whole answer (GRA-1845), in its
// connection's group (brain-next-origins.ts `captureGroupOf`), so
// disconnecting it erases them all in one call (GRA-1827). The Brain knows
// no connector: to it, this is one producer's id like any other.

/** A connection, as capture and its erasure read whose it is. */
type Owned = Pick<ConnectionOwner, "source" | "ownerUserId">;

/**
 * Whether capture keeps the whole answer of a read through a connection
 * of `source` as one source, keyed by the call (GRA-1845): any MCP
 * server's but a native connector's, whose reads are kept item by item,
 * so today a toolkit's. Never connect's own HTTP requests.
 */
export const keepsWholeAnswers = (source: ConnectionSource): boolean =>
  source !== "native" && source !== "http";

/**
 * Whether captures may be kept through `connection` for `personId`, by
 * this release or an earlier one: their own connection, of a kind capture
 * keeps reads from (a native connector's, or one whose whole answers it
 * keeps), to any provider, whatever its tools are classed now. What
 * disconnecting it erases by, and what the Brain page and the disconnect
 * dialog say by, so neither promises less than may be kept: a tool
 * reclassed since, or a provider an earlier release kept reads from (a
 * rollback), still has its captures erased.
 */
export const mayHoldCapturesOf = (
  connection: Owned,
  personId: string
): boolean =>
  (connection.source === "native" || keepsWholeAnswers(connection.source)) &&
  connection.ownerUserId === personId;

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

/**
 * The id the whole answer of the call of the tool `action` with `input`
 * through `connectionId` is kept under for `personId` (GRA-1845): an
 * answer that names no item is one source, keyed by the call. The input
 * in canonical JSON (RFC 8785, `canonicalText`), so the same arguments in
 * another order are the same call, whose next version a read again makes,
 * and two different calls never share a key. Hashed, never kept: an
 * argument may be anything the agent typed. Tagged `answer`, so no call's
 * arguments ever make the key of a native item (`captureIdOf`).
 */
export const answerCaptureIdOf = async (
  connectionId: string,
  personId: string,
  action: string,
  input: unknown
): Promise<string> =>
  `${captureGroupOf(connectionId).id}/${await sha256Hex(JSON.stringify([personId, action, "answer", canonicalText(input)]))}`;
