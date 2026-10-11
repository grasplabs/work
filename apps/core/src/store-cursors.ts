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
// handed to App code and back. It is the store's own signed statement,
// never something a caller can make.
//
// Threat model, and how each is closed:
//
// - A caller forges a cursor, or edits one, to read from a place of its
//   choosing: a cursor carries an HMAC-SHA256 under a key only its store
//   holds (random, in its own SQLite, `sdk_store.cursor_key`), checked in
//   constant time before anything in it is read; anything that doesn't
//   verify is `data.invalid_cursor`, and a store never accepts another
//   store's cursor.
// - A caller reuses a cursor for another query, table, index, filter,
//   order, range, App, version, schema, person or role: the MAC covers the
//   digest of all of them (`CursorBinding`), recomputed from the request
//   and the scope core resolved, never read from the cursor, so any
//   difference fails verification (`data.invalid_cursor`) and a cursor
//   reveals none of it.
// - A cursor outlives the code that made it: it names its format's
//   version, and the binding covers the expressions' version; a cursor of
//   another version is `data.cursor_expired`, as is one whose anchor
//   record is gone when the cursor carried only its ID.
// - A cursor leaks what the caller may not see: it holds the last record
//   of the page the caller was answered, its ID and order fields' values,
//   which the caller was just given; nothing about the query or scope.
// - A cursor grows without bound: at most `cursorMaxLength` characters;
//   when a page's last record's values wouldn't fit, the cursor carries
//   only its ID, and the next page looks the record up under the same
//   access.

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

const anchorValueSchema = z.union([
  z.tuple([]),
  z.tuple([z.null()]),
  z.tuple([z.union([z.string(), z.number()])]),
]);

const payloadSchema = z.strictObject({
  id: z.string().min(1).max(256),
  values: z.array(anchorValueSchema).max(17).optional(),
});

const cursorPattern =
  /^(?<version>\d{1,4})\.(?<payload>[A-Za-z0-9_-]{1,4000})\.(?<mac>[A-Za-z0-9_-]{43})$/u;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

/** The message a cursor's MAC covers: its version, binding and payload. */
const messageOf = async (
  binding: CursorBinding,
  payload: string
): Promise<Uint8Array> => {
  const digest = await sha256Hex(
    canonicalJson({
      storeId: binding.storeId,
      schemaHash: binding.schemaHash,
      consumer: { ...binding.consumer },
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
      emitterVersion,
      cursorVersion,
    })
  );
  return encoder.encode(`${cursorVersion}.${digest}.${payload}`);
};

/**
 * A cursor for the page after `anchor`, bound to `binding`, signed with
 * `key`: with the anchor's values when the cursor fits within
 * `cursorMaxLength`, otherwise with its ID only.
 */
export const sealCursor = async (
  key: CryptoKey,
  binding: CursorBinding,
  anchor: Required<Anchor>
): Promise<string> => {
  for (const content of [anchor, { id: anchor.id }]) {
    const payload = toBase64Url(encoder.encode(JSON.stringify(content)));
    // One after the other: the shorter only when the longer won't fit.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      // oxlint-disable-next-line no-await-in-loop -- see above
      await messageOf(binding, payload)
    );
    const cursor = `${cursorVersion}.${payload}.${toBase64Url(new Uint8Array(mac))}`;
    if (cursor.length <= cursorMaxLength) {
      return cursor;
    }
  }
  throw new Error("A record ID doesn't fit in a cursor");
};

/**
 * The anchor `cursor` carries, if `key` signed it for `binding`:
 * `data.cursor_expired` for another format version, `data.invalid_cursor`
 * for anything that doesn't verify or read.
 */
export const openCursor = async (
  key: CryptoKey,
  binding: CursorBinding,
  cursor: string
): Promise<Anchor> => {
  const match = cursorPattern.exec(cursor);
  if (match === null) {
    throw dataErrors.create("data.invalid_cursor");
  }
  const { version, payload = "", mac = "" } = match.groups ?? {};
  if (Number(version) !== cursorVersion) {
    throw dataErrors.create("data.cursor_expired");
  }
  let verified = false;
  try {
    verified = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(mac),
      await messageOf(binding, payload)
    );
  } catch {
    // Not base64url: not a cursor this store made.
  }
  if (!verified) {
    throw dataErrors.create("data.invalid_cursor");
  }
  let content: unknown = null;
  try {
    content = JSON.parse(decoder.decode(fromBase64Url(payload)));
  } catch {
    // Signed, yet unreadable: refused as below.
  }
  const anchor = payloadSchema.safeParse(content);
  if (!anchor.success) {
    throw dataErrors.create("data.invalid_cursor");
  }
  return anchor.data;
};

/** A store's cursor key, from its stored hex, ready to sign and verify. */
export const cursorKeyOf = async (hex: string): Promise<CryptoKey> =>
  await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(hex.match(/../gu) ?? [], (pair) =>
      Number.parseInt(pair, 16)
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
