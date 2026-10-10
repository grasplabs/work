import { z } from "zod";

// What the model ledger bounds a provider request by, read from the body
// the gateway is about to send (models.ts): its size, which bounds its
// prompt, as a token is at least one byte of the text it stands for; the
// answer's cap it sets; and anything in it that would break either bound,
// or that the catalog's prices don't price, which is refused rather than
// sent. None of it is sent today: the guard keeps it so.

/** Bytes of a request's body as sent; `undefined` for a body of another kind. */
export const bodyBytes = (body: unknown): number | undefined => {
  if (typeof body === "string") {
    return new TextEncoder().encode(body).byteLength;
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return body.byteLength;
  }
  return undefined;
};

/** A body as JSON; `undefined` when it isn't JSON text. */
const parsedBody = (body: unknown): unknown => {
  if (typeof body !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

/** The fields the providers' APIs cap an answer's tokens with. */
const outputCapSchema = z.object({
  max_tokens: z.int().positive().optional(),
  max_output_tokens: z.int().positive().optional(),
  max_completion_tokens: z.int().positive().optional(),
});

/**
 * The most tokens the request's answer may take, as its body tells the
 * provider: the largest of Anthropic's and chat completions' `max_tokens`
 * (a reasoning budget is part of it), chat completions' newer
 * `max_completion_tokens`, and OpenAI's `max_output_tokens` (reasoning
 * included), should it set more than one. `undefined` when it sets none.
 */
export const outputCapOf = (body: unknown): number | undefined => {
  const caps = outputCapSchema.safeParse(parsedBody(body)).data;
  const set = [
    caps?.max_tokens,
    caps?.max_output_tokens,
    caps?.max_completion_tokens,
  ].filter((cap) => cap !== undefined);
  return set.length === 0 ? undefined : Math.max(...set);
};

/**
 * Content parts whose tokens aren't bounded by their bytes: an image or a
 * document is billed by what it shows, and a file by reference holds no
 * bytes of it at all.
 */
const unboundedParts = new Set([
  "image",
  "image_url",
  "input_image",
  "document",
  "file",
  "input_file",
]);

/** Top-level fields the bound or the prices don't cover. */
const unboundedFields = [
  // The earlier response's prompt is billed again, and isn't in the body.
  "previous_response_id",
  // Priority or flex processing is priced apart from the catalog's prices.
  "service_tier",
] as const;

/**
 * Where a body declares schemas rather than holding content: a tool's or
 * a structured answer's, whose `type` fields are JSON Schema's.
 */
const schemaFields = new Set([
  "tools",
  "tool_choice",
  "text",
  "response_format",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What in `value`, content anywhere in a body, the bound can't cover. */
const unboundedIn = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = unboundedIn(item);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.type === "string" && unboundedParts.has(value.type)) {
    return value.type;
  }
  // Anthropic charges a one-hour cache write at twice the input price,
  // which the catalog's cache-write price doesn't cover.
  if (isRecord(value.cache_control) && value.cache_control.ttl === "1h") {
    return "cache_ttl";
  }
  for (const [key, inner] of Object.entries(value)) {
    if (!schemaFields.has(key)) {
      const found = unboundedIn(inner);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
};

/**
 * What in a request's body its bytes can't bound or the catalog's prices
 * can't price, if anything: `undefined` for a body the ledger can bound.
 * A body that isn't JSON can't be read, so it can't be bounded either.
 */
export const unboundedBy = (body: unknown): string | undefined => {
  const parsed = parsedBody(body);
  if (!isRecord(parsed)) {
    return "body";
  }
  const field = unboundedFields.find((name) => parsed[name] !== undefined);
  return field ?? unboundedIn(parsed);
};
