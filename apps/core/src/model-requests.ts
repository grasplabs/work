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

// A denylist, not a per-adapter allowlist of fields: the provider SDKs
// add fields of their own from release to release (caching keys,
// metadata, reasoning settings) that cost nothing beyond the prompt and
// the answer, and an allowlist would refuse every call on the first new
// one. What is refused is what bills beyond the bound, as each provider
// documents it.

/**
 * Content parts whose tokens aren't bounded by their bytes: an image, a
 * document or audio is billed by what it holds, and a file by reference
 * holds no bytes of it at all.
 */
const unboundedParts = new Set([
  "image",
  "image_url",
  "input_image",
  "document",
  "file",
  "input_file",
  "input_audio",
  "audio",
  // An earlier item by reference, whose tokens aren't in the body, and a
  // screenshot, billed as an image.
  "item_reference",
  "computer_screenshot",
]);

/** Top-level fields the bound or the prices don't cover. */
const unboundedFields = [
  // The earlier response's or conversation's prompt is billed again, and
  // isn't in the body; a stored prompt isn't either.
  "previous_response_id",
  "conversation",
  "prompt",
  // Priority, flex or fast processing is priced apart from the catalog.
  "service_tier",
  "speed",
  // More than one answer, each billed.
  "n",
  "best_of",
  // Audio in or out, priced apart; predicted output, billed past the cap.
  "modalities",
  "audio",
  "prediction",
  // Workers AI's vision input, billed by what it shows.
  "image",
  // Hosted execution and servers the provider runs, and bills, itself.
  "container",
  "mcp_servers",
] as const;

/**
 * Where a body declares schemas rather than holding content: a structured
 * answer's, whose `type` fields are JSON Schema's. Tools are read apart
 * (`unboundedTool`).
 */
const schemaFields = new Set([
  "tools",
  "tool_choice",
  "text",
  "response_format",
]);

/**
 * Tool types the client runs: the provider only writes the call, whose
 * tokens are part of the answer. Anthropic's client tools have no type.
 * Any other type is a tool the provider runs and bills on its own, such
 * as web search or code execution.
 */
const clientTools = new Set(["function", "custom"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `value` asks, anywhere in it, for a one-hour cache write. */
const cachesForAnHour = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(cachesForAnHour);
  }
  if (!isRecord(value)) {
    return false;
  }
  return (
    (isRecord(value.cache_control) && value.cache_control.ttl === "1h") ||
    Object.values(value).some(cachesForAnHour)
  );
};

/** What in a body's `tools` the bound can't cover, if anything. */
const unboundedTool = (tools: unknown): string | undefined => {
  if (tools === undefined) {
    return undefined;
  }
  if (!Array.isArray(tools)) {
    return "tool";
  }
  for (const tool of tools) {
    if (
      !isRecord(tool) ||
      (tool.type !== undefined &&
        !(typeof tool.type === "string" && clientTools.has(tool.type)))
    ) {
      return "tool";
    }
    // Anthropic charges a one-hour cache write at twice the input price.
    if (cachesForAnHour(tool)) {
      return "cache_ttl";
    }
  }
  return undefined;
};

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
  // US-only inference costs 1.1x on Claude 4.6 and later (Anthropic's
  // pricing page, "Data residency pricing", read 2026-10-10); global
  // routing, the default, costs the catalog's prices.
  if (parsed.inference_geo !== undefined && parsed.inference_geo !== "global") {
    return "inference_geo";
  }
  const field = unboundedFields.find((name) => parsed[name] !== undefined);
  return field ?? unboundedTool(parsed.tools) ?? unboundedIn(parsed);
};
