// The key of a source captured from a connection (GRA-1730,
// connection-capture.ts): its connection, then a hash that names one item
// for its person. The Brain knows no connector: to it, this is one
// producer's id like any other. Core reads the connection back from it to
// say where else to look (`elsewhere` in brain-next.ts `recallAs`).

/** A SHA-256 digest as 64 lowercase hex characters. */
const hexDigestLength = 64;

/** What follows the connection: "/" and the hash. */
const itemPartLength = hexDigestLength + 1;

const itemPart = /^\/[0-9a-f]{64}$/u;

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
 * The id the item `itemId` (as its connector names it) read through
 * `connectionId` is kept under for `personId`: `<connection>/<hash>`.
 * Reading the item again makes its next version. The hash covers the
 * person, so no two people's reads share a source; an outside ID is
 * hashed, never put in a key as it is, so none reaches another kind's
 * keys or lengthens it. (A connection ID too long for a source's id is
 * refused by core's Brain module, as any producer's id is.)
 */
export const captureIdOf = async (
  connectionId: string,
  personId: string,
  itemId: string
): Promise<string> =>
  `${connectionId}/${await sha256Hex(JSON.stringify([personId, itemId]))}`;

/** The connection a captured source's id names (`captureIdOf`), if it is one. */
export const connectionOfCapture = (id: string): string | undefined => {
  const at = id.length - itemPartLength;
  return at > 0 && itemPart.test(id.slice(at)) ? id.slice(0, at) : undefined;
};
