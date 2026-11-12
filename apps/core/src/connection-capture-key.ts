// The key of a source captured from a connection (GRA-1730, connection-capture.ts):
// its connection, then a hash that names the item for its person. The
// Brain knows no connector: to it, this is one producer's id like any
// other. Core reads the connection back from it to say where else to look
// (`elsewhere` in brain-next.ts `recallAs`).

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

/** What a captured source is the item of, as connect said (`ConnectResult.keep`). */
export type CapturedItem =
  /** The items the read named, as its connector gave their IDs. */
  | { kind: "item"; items: readonly string[] }
  /** A read that named none: its answer is the item. */
  | { kind: "answer"; text: string };

/**
 * The id a capture of `item` through `connectionId`, for `personId`, is
 * kept under: `<connection>/<hash>`. The hash covers the person, so two
 * people reading one item through a shared connection keep two sources,
 * and neither's read ends or numbers the other's; and the item's IDs as a
 * set, so reading the same items again makes their next version. Outside
 * IDs are hashed, never put in a key as they are: none can reach another
 * kind's keys or lengthen it. (A connection ID too long for a source's id
 * is refused by core's Brain module, as any producer's id is.)
 */
export const captureIdOf = async (
  connectionId: string,
  personId: string,
  item: CapturedItem
): Promise<string> => {
  const named =
    item.kind === "item"
      ? [personId, item.kind, [...new Set(item.items)].toSorted()]
      : [personId, item.kind, item.text];
  return `${connectionId}/${await sha256Hex(JSON.stringify(named))}`;
};

/** The connection a captured source's id names (`captureIdOf`), if it is one. */
export const connectionOfCapture = (id: string): string | undefined => {
  const at = id.length - itemPartLength;
  return at > 0 && itemPart.test(id.slice(at)) ? id.slice(0, at) : undefined;
};
