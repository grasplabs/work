import type { FetchFunction } from "@earendil-works/pi-ai";

// Mistral's chat completions stream in OpenAI's shape but for one thing:
// a model asked to reason (`reasoning_effort`) sends a delta's `content`
// as a list of chunks, its thinking (`{type: "thinking", thinking: [...]}`)
// and its answer (`{type: "text", text}`), where OpenAI sends a string.
// pi's OpenAI adapter, which the gateway speaks Mistral with
// (model-catalog.ts), adds that list to the answer's text as it would a
// string. So each such delta is put in OpenAI's own words first: the
// thinking as `reasoning_content`, the answer as `content`.

/** A chunk of a Mistral delta's `content`, as far as the gateway reads it. */
interface ContentChunk {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
}

const isChunk = (value: unknown): value is ContentChunk =>
  typeof value === "object" && value !== null;

/** The text of a chunk's parts: a string, or text chunks of one. */
const textOf = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part: unknown) =>
      isChunk(part) && typeof part.text === "string" ? part.text : ""
    )
    .join("");
};

/** A delta whose `content` is a list, in OpenAI's words; any other as it is. */
const openAiDelta = (
  delta: Record<string, unknown>
): Record<string, unknown> => {
  const { content } = delta;
  if (!Array.isArray(content)) {
    return delta;
  }
  let text = "";
  let thinking = "";
  for (const chunk of content) {
    if (typeof chunk === "string") {
      text += chunk;
    } else if (isChunk(chunk) && chunk.type === "thinking") {
      thinking += textOf(chunk.thinking);
    } else if (isChunk(chunk) && typeof chunk.text === "string") {
      text += chunk.text;
    }
  }
  return {
    ...delta,
    content: text,
    ...(thinking === "" ? {} : { reasoning_content: thinking }),
  };
};

/** One `data:` line of the stream, with its deltas in OpenAI's words. */
export const openAiLine = (line: string): string => {
  const data = /^data: ?(?<json>\{.*\})\s*$/u.exec(line)?.groups?.json;
  if (data === undefined || !data.includes('"content":[')) {
    return line;
  }
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    return line;
  }
  if (
    !isChunk(event) ||
    !("choices" in event) ||
    !Array.isArray(event.choices)
  ) {
    return line;
  }
  const choices: unknown[] = event.choices.map((choice: unknown) => {
    if (!isChunk(choice) || !("delta" in choice) || !isChunk(choice.delta)) {
      return choice;
    }
    // SAFETY: an object, as `isChunk` checked; its fields are only read.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const delta = choice.delta as Record<string, unknown>;
    return { ...choice, delta: openAiDelta(delta) };
  });
  return `data: ${JSON.stringify({ ...event, choices })}`;
};

/** A Mistral event stream, its lines put in OpenAI's words as they come. */
const openAiStream = (body: ReadableStream): ReadableStream<Uint8Array> => {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let held = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (bytes, controller) => {
        held += decoder.decode(bytes, { stream: true });
        const lines = held.split("\n");
        held = lines.pop() ?? "";
        if (lines.length > 0) {
          controller.enqueue(
            encoder.encode(`${lines.map(openAiLine).join("\n")}\n`)
          );
        }
      },
      flush: (controller) => {
        held += decoder.decode();
        if (held !== "") {
          controller.enqueue(encoder.encode(openAiLine(held)));
        }
      },
    })
  );
};

/** `fetch` with Mistral's answers streamed in OpenAI's words. */
export const withOpenAiContent =
  (fetch: FetchFunction): FetchFunction =>
  async (input, init) => {
    const answered = await fetch(input, init);
    const streamed =
      answered.body !== null &&
      (answered.headers.get("content-type") ?? "").includes(
        "text/event-stream"
      );
    if (!answered.ok || !streamed || answered.body === null) {
      return answered;
    }
    return new Response(openAiStream(answered.body), {
      status: answered.status,
      statusText: answered.statusText,
      headers: answered.headers,
    });
  };
