import type { Api } from "@earendil-works/pi-ai";
import { toBase64 } from "@grasp-os/shared/encoding";

// A document a model reads as it is: a PDF, for Grasp's own conversion of
// uploads into the Brain (knowledge/extract.ts, through
// `models(env).platformCall`). pi's adapters send text and images only, so
// the gateway adds the document to the request's last user message as the
// provider's API takes one (`withDocument`), in the body pi made, before
// the ledger admits it and it is sent:
//
// - OpenAI's Responses API: an `input_file` part with the file's data.
// - Anthropic's Messages API: a `document` block, base64.
// - Chat completions (OpenRouter): a `file` part with the file's data.
//
// What a document costs isn't bounded by its bytes (each page is read as
// text and as an image), so the ledger bounds such a request by the
// model's whole context window instead (models.ts): the provider refuses
// a request beyond it, unbilled.

/** A document for a model to read, as a platform feature sends it. */
export interface ModelDocument {
  /** The file's name, as the provider is told it. */
  name: string;
  mediaType: "application/pdf";
  bytes: Uint8Array;
}

/** The content parts a document is sent as, by the API it goes to. */
export const documentPartTypes = {
  "openai-responses": "input_file",
  "anthropic-messages": "document",
  "openai-completions": "file",
} as const satisfies Partial<Record<Api, string>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a document can be sent to `api`. */
export const takesDocuments = (
  api: Api
): api is keyof typeof documentPartTypes =>
  Object.hasOwn(documentPartTypes, api);

/** `document` as the content part `api` takes it in. */
const partOf = (
  api: keyof typeof documentPartTypes,
  { name, mediaType, bytes }: ModelDocument
): Record<string, unknown> => {
  const data = toBase64(bytes);
  if (api === "anthropic-messages") {
    return {
      type: "document",
      source: { type: "base64", media_type: mediaType, data },
    };
  }
  const fileData = `data:${mediaType};base64,${data}`;
  return api === "openai-responses"
    ? { type: "input_file", filename: name, file_data: fileData }
    : { type: "file", file: { filename: name, file_data: fileData } };
};

/** A user message's content as parts: text as a text part of `api`'s. */
const partsOf = (
  api: keyof typeof documentPartTypes,
  content: unknown
): unknown[] => {
  if (Array.isArray(content)) {
    return content;
  }
  if (typeof content !== "string") {
    return [];
  }
  return [
    api === "openai-responses"
      ? { type: "input_text", text: content }
      : { type: "text", text: content },
  ];
};

/**
 * `payload`, the body pi made for `api`, with `document` in front of its
 * last user message's content, as the providers advise; `undefined` when
 * the payload has no user message to put it in, or `api` takes none.
 */
export const withDocument = (
  api: Api,
  payload: unknown,
  document: ModelDocument
): unknown => {
  if (!(takesDocuments(api) && isRecord(payload))) {
    return undefined;
  }
  const field = api === "openai-responses" ? "input" : "messages";
  const items = payload[field];
  if (!Array.isArray(items)) {
    return undefined;
  }
  const at = items.findLastIndex(
    (item) => isRecord(item) && item.role === "user"
  );
  const last: unknown = items[at];
  if (!isRecord(last)) {
    return undefined;
  }
  const withPart = {
    ...last,
    content: [partOf(api, document), ...partsOf(api, last.content)],
  };
  return { ...payload, [field]: items.with(at, withPart) };
};
