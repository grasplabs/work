import {
  fromBase64Url,
  sha256Hex,
  toBase64Url,
} from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { cursorMaxLength } from "@grasp-os/shared/store-limits";
import type { FilterNode, RangeBound } from "@grasp-os/shared/store-reads";
import { dataErrors } from "@grasp-os/shared/stores";
import { z } from "zod";

import { emitterVersion } from "./store-expressions.ts";
import type { Anchor } from "./store-queries.ts";

// A page's cursor (spec 9.2): where the next page of one query starts,
// handed to App code and back. It is the store's own sealed statement,
// opaque to whoever holds it, never something a caller can make.
//
// Its text is `<version>.<sealed anchor>.<tag>.<stable tag>`, every part
// canonical base64url (one spelling per value). The anchor (the last
// record's ID and order values) is encrypted with AES-GCM; both tags are
// HMAC-SHA256 over the version, the sealed anchor and a digest of what
// the cursor is bound to. Both keys are derived (HKDF, a label each) from
// one random key only its store holds, in its own SQLite
// (`sdk_store.cursor_key`), minted by the store's first page and cleared
// when the store is purged.
//
// Threat model, and how each is closed:
//
// - A caller forges or edits a cursor to read from a place of its
//   choosing: both tags are checked, in constant time, before anything in
//   the cursor is acted on, its version included; the anchor is decrypted
//   only after. Anything that doesn't verify is `data.invalid_cursor`, and
//   a store never accepts another store's cursor (its keys differ).
// - A caller reuses a cursor for another query or caller: the tag covers
//   the digest of everything the cursor is bound to (`CursorBinding`),
//   recomputed from the request and the scope core resolved, never read
//   from the cursor: another table, index, range, filter, order, App,
//   person or role fails both tags (`data.invalid_cursor`).
// - A cursor outlives the generation that made it (spec 9.2: the App's
//   version, the schema it is pinned to, the expressions' and the format's
//   versions): the stable tag covers the binding without those, so a
//   cursor whose stable tag verifies but whose full tag doesn't (or of
//   another format version) is `data.cursor_expired`. That is only told
//   apart once the stable tag verified, so it is no oracle for strangers.
//   An ID-only cursor whose record is gone expires too.
// - A cursor leaks what it shouldn't: it is opaque. Its anchor is
//   encrypted, so neither record IDs nor field values can be read from it,
//   and it reveals nothing of the query or scope.
// - A cursor grows without bound: at most `cursorMaxLength` characters (a
//   longer one is refused at the boundary as `data.invalid_query`); when
//   the last record's values wouldn't fit, the cursor seals only its ID,
//   and the next page looks the record up under the same access.

/** The version of the cursor format below. */
export const cursorVersion = 1;

/** Everything a cursor is bound to: one query, for one caller. */
export interface CursorBinding {
  readonly storeId: string;
  readonly schemaHash: string;
  readonly consumer: { resourceId: string; resourceVersion: number };
  readonly principal: string;
  readonly appMember: boolean;
  readonly appBuilder: boolean;
  readonly table: string;
  readonly index: string | null;
  readonly range: readonly RangeBound[];
  readonly filter: FilterNode | null;
  readonly order: "asc" | "desc";
}

/** The keys a store seals and tags its cursors with. */
export interface CursorKeys {
  readonly tag: CryptoKey;
  readonly seal: CryptoKey;
}

const anchorValueSchema = z.union([
  z.tuple([]),
  z.tuple([z.null()]),
  z.tuple([z.union([z.string(), z.number()])]),
]);

const payloadSchema = z.strictObject({
  id: z.string().min(1).max(256),
  values: z.array(anchorValueSchema).max(17).optional(),
});

/**
 * The characters of a cursor around its sealed anchor: the version (one
 * digit today), three dots and two 43-character tags.
 */
const cursorFixedLength = 90;

/**
 * A cursor's text. The sealed anchor's bound follows from the cursor's,
 * so every cursor `sealCursor` issues is one this reads back.
 */
const cursorPattern = new RegExp(
  String.raw`^(?<version>0|[1-9]\d{0,3})\.(?<sealed>[A-Za-z0-9_-]{1,${cursorMaxLength - cursorFixedLength}})\.(?<tag>[A-Za-z0-9_-]{43})\.(?<stable>[A-Za-z0-9_-]{43})$`,
  "u"
);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The bytes of canonical base64url `text`, or undefined for any other spelling. */
const canonicalBytes = (text: string): Uint8Array | undefined => {
  try {
    const bytes = fromBase64Url(text);
    return toBase64Url(bytes) === text ? bytes : undefined;
  } catch {
    return undefined;
  }
};

/** A filter as JSON, for the binding's digest (bounded: depth 8). */
const filterJson = (node: FilterNode): Json => {
  if ("and" in node) {
    return { and: node.and.map(filterJson) };
  }
  if ("or" in node) {
    return { or: node.or.map(filterJson) };
  }
  if ("not" in node) {
    return { not: filterJson(node.not) };
  }
  if (node.op === "in") {
    return { field: node.field, op: node.op, values: [...node.values] };
  }
  return { field: node.field, op: node.op, value: node.value };
};

/**
 * The digest of `binding`: with its generation (the App's version, the
 * schema, the expressions' version) for the full tag, without it for the
 * stable tag.
 */
const digestOf = async (
  binding: CursorBinding,
  withGeneration: boolean
): Promise<string> =>
  await sha256Hex(
    canonicalJson({
      storeId: binding.storeId,
      resourceId: binding.consumer.resourceId,
      principal: binding.principal,
      appMember: binding.appMember,
      appBuilder: binding.appBuilder,
      table: binding.table,
      index: binding.index,
      range: binding.range.map(({ field, op, value }) => ({
        field,
        op,
        value,
      })),
      filter: binding.filter === null ? null : filterJson(binding.filter),
      order: binding.order,
      generation: withGeneration
        ? {
            resourceVersion: binding.consumer.resourceVersion,
            schemaHash: binding.schemaHash,
            emitterVersion,
          }
        : null,
    })
  );

/** The message a tag covers: the version, the binding and the sealed anchor. */
const messageOf = async (
  version: string,
  binding: CursorBinding,
  sealed: string,
  withGeneration: boolean
): Promise<Uint8Array> =>
  encoder.encode(
    `${version}.${await digestOf(binding, withGeneration)}.${sealed}`
  );

/** One tag of `sealed` for `binding`, under `version`. */
const tagOf = async (
  keys: CursorKeys,
  version: string,
  binding: CursorBinding,
  sealed: string,
  withGeneration: boolean
): Promise<string> =>
  toBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        keys.tag,
        await messageOf(version, binding, sealed, withGeneration)
      )
    )
  );

/**
 * A cursor for the page after `anchor`, bound to `binding`: the anchor's
 * values sealed when the cursor fits within `cursorMaxLength`, otherwise
 * its ID only.
 */
export const sealCursor = async (
  keys: CursorKeys,
  binding: CursorBinding,
  anchor: Required<Anchor>
): Promise<string> => {
  const version = String(cursorVersion);
  for (const content of [anchor, { id: anchor.id }]) {
    // A random 96-bit IV per cursor: AES-GCM stays sound for 2^32 seals
    // under one key, far past what one store pages; its key never rotates
    // (it goes only with the store's purge).
    const iv = crypto.getRandomValues(new Uint8Array(12));
    // One after the other: the shorter only when the longer won't fit.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      keys.seal,
      encoder.encode(JSON.stringify(content))
    );
    const sealed = toBase64Url(
      new Uint8Array([...iv, ...new Uint8Array(encrypted)])
    );
    // oxlint-disable-next-line no-await-in-loop -- see above
    const tag = await tagOf(keys, version, binding, sealed, true);
    // oxlint-disable-next-line no-await-in-loop -- see above
    const stable = await tagOf(keys, version, binding, sealed, false);
    const cursor = `${version}.${sealed}.${tag}.${stable}`;
    // Only a cursor `openCursor` reads back: otherwise the next page would
    // be refused, and a record could block everyone's paging past it.
    if (cursor.length <= cursorMaxLength && cursorPattern.test(cursor)) {
      return cursor;
    }
  }
  throw new Error("A record ID doesn't fit in a cursor");
};

/** Whether `tag` (canonical base64url) is the HMAC of `message`. */
const verifies = async (
  keys: CursorKeys,
  tag: string,
  message: Uint8Array
): Promise<boolean> => {
  const bytes = canonicalBytes(tag);
  return (
    bytes !== undefined &&
    (await crypto.subtle.verify("HMAC", keys.tag, bytes, message))
  );
};

/**
 * The anchor `cursor` carries, if this store sealed it for `binding`:
 * `data.cursor_expired` when it did, for this query and caller, but under
 * another generation or format version; `data.invalid_cursor` otherwise.
 * Nothing in the cursor is acted on before a tag verifies.
 */
export const openCursor = async (
  keys: CursorKeys,
  binding: CursorBinding,
  cursor: string
): Promise<Anchor> => {
  const groups = cursorPattern.exec(cursor)?.groups;
  if (groups === undefined) {
    throw dataErrors.create("data.invalid_cursor");
  }
  const { version = "", sealed = "", tag = "", stable = "" } = groups;
  const full = await verifies(
    keys,
    tag,
    await messageOf(version, binding, sealed, true)
  );
  const same =
    full ||
    (await verifies(
      keys,
      stable,
      await messageOf(version, binding, sealed, false)
    ));
  if (!same) {
    throw dataErrors.create("data.invalid_cursor");
  }
  if (!full || version !== String(cursorVersion)) {
    throw dataErrors.create("data.cursor_expired");
  }
  const bytes = canonicalBytes(sealed);
  let content: unknown = null;
  if (bytes !== undefined && bytes.length > 12) {
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12) },
        keys.seal,
        bytes.slice(12)
      );
      content = JSON.parse(decoder.decode(plain));
    } catch {
      // Tagged, yet not sealed by this store: refused as below.
    }
  }
  const anchor = payloadSchema.safeParse(content);
  if (!anchor.success) {
    throw dataErrors.create("data.invalid_cursor");
  }
  return anchor.data;
};

/**
 * A store's cursor keys, derived from its stored key (32 bytes in hex)
 * with HKDF-SHA256, one label each for the tag and the seal.
 */
export const cursorKeysOf = async (hex: string): Promise<CursorKeys> => {
  const root = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(hex.match(/../gu) ?? [], (pair) =>
      Number.parseInt(pair, 16)
    ),
    "HKDF",
    false,
    ["deriveKey"]
  );
  const info = (label: string): SubtleCryptoDeriveKeyAlgorithm => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(0),
    info: encoder.encode(label),
  });
  const tag = await crypto.subtle.deriveKey(
    info("grasp-cursor-tag-v1"),
    root,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"]
  );
  const seal = await crypto.subtle.deriveKey(
    info("grasp-cursor-seal-v1"),
    root,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  return { tag, seal };
};
