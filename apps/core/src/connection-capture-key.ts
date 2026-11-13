import { captureGroupOf } from "./brain-next-origins.ts";

// The key of a source captured from a connection (GRA-1730,
// connection-capture.ts): its connection, then a hash that names one item
// for its person, in its connection's group (brain-next-origins.ts
// `captureGroupOf`), so disconnecting it erases them all in one call
// (GRA-1827). The Brain knows no connector: to it, this is one producer's
// id like any other.

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
