import { readAtMost } from "@grasp-os/shared/http";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import type { z } from "zod";

import { derivedHmacKey } from "./derived-keys.ts";

// What the console sends core, signed: lowercase hex HMAC-SHA256 of the
// body, in `platformUpdateSignatureHeader`, with a key both derive from
// core's auth secret for one purpose (`hkdfHmacKey`), which the console
// derives from its client key. So only the console can make one; the
// router secret it passes first only says it came through the router, as
// everyone's request does. Each body carries when it was sent, and is
// taken only within a few minutes of that, so one caught on its way can't
// be sent again later. Its actual body is read up to a bound, whatever its
// headers say.

/** Why a signed request was refused, as logged: never its body or signature. */
export type ConsoleRefusal =
  | "too_large"
  | "unsigned"
  | "bad_signature"
  | "invalid"
  | "stale";

/** Signatures: 32 bytes as lowercase hex. */
const signaturePattern = /^[0-9a-f]{64}$/u;

/** Two hex characters at a time. */
const hexPair = /../gu;

/** `hex`, lowercase hex characters, as bytes. */
const hexBytes = (hex: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(hex.match(hexPair) ?? [], (pair) =>
    Number.parseInt(pair, 16)
  );

/**
 * What the console's signed `request` carries, checked against `schema`
 * and its `sentAt` against core's clock, or why it's refused.
 */
export const consoleSigned = async <T extends { sentAt: string }>(
  request: Request,
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  {
    purpose,
    schema,
    maxBytes,
    maxSkewMs,
  }: {
    purpose: string;
    schema: z.ZodType<T>;
    maxBytes: number;
    maxSkewMs: number;
  }
): Promise<T | ConsoleRefusal> => {
  // SAFETY: a request's body in workerd is a byte stream, of Uint8Array
  // chunks; its type says `any` only for streams in general.
  const stream = request.body as ReadableStream<Uint8Array> | null;
  const body =
    stream === null ? new Uint8Array() : await readAtMost(stream, maxBytes);
  if (body === undefined) {
    return "too_large";
  }
  const signature = request.headers.get(platformUpdateSignatureHeader) ?? "";
  if (!signaturePattern.test(signature)) {
    return "unsigned";
  }
  const key = await derivedHmacKey(env, purpose, ["verify"]);
  // `verify` compares in constant time.
  if (!(await crypto.subtle.verify("HMAC", key, hexBytes(signature), body))) {
    return "bad_signature";
  }
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return "invalid";
  }
  const checked = schema.safeParse(parsed);
  if (!checked.success) {
    return "invalid";
  }
  const skew = Math.abs(Date.now() - Date.parse(checked.data.sentAt));
  return skew > maxSkewMs ? "stale" : checked.data;
};
