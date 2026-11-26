import { errorFields, log } from "@grasp-os/shared/log";
import { z } from "zod";

// Composio's REST API, as connect calls it: the only place in Grasp that
// does (threat model CN17). Core reaches Composio only through connect, and
// nothing but connect holds the key, a Worker secret the admin sets
// (`COMPOSIO_API_KEY`). While it is unset, nothing of Composio is offered
// or reached.
//
// Each safeguard, and why:
// - The key goes only to Composio's API host: the base URL is fixed here,
//   and a redirect is never followed, since following one would send the
//   key wherever Composio's answer pointed.
// - Everything Composio sends is untrusted. Each answer is read up to a
//   size cap as it arrives (never trusting `content-length`), so a huge or
//   endless answer can't exhaust the isolate, then validated before
//   anything uses it. Names, categories and descriptions are Composio's
//   text: the UI renders them as text, never as markup.
// - Every failure (no answer in time, an error status, a redirect, an
//   oversized or unreadable answer, even a body that won't cancel) ends as
//   one `ComposioError`, so callers fall back as one: the catalog lists the
//   native providers alone.
// - Logs carry the method, the path's first segment and the status: never
//   the key, the query or a body. Of an error's answer only its slug is
//   read, a word Composio names the error with, never its message.

/** Composio's REST API. */
export const composioApiBase = "https://backend.composio.dev/api/v3.1";

/** How long one request to Composio may take, unless it asks for less. */
export const requestTimeoutMs = 10_000;

/** Largest answer connect reads from Composio's API, in bytes. */
const maxResponseBytes = 4 * 1024 * 1024;

/** What a {@link ComposioError} knows beyond its message. */
interface ComposioFailure {
  /** Composio's HTTP status, when it answered with one. */
  status?: number;
  cause?: unknown;
  /** Composio's name for the error (`error.slug`). */
  slug?: string;
  /** Composio's number for the error (`error.code`). */
  code?: number;
  /** Composio didn't answer at all. */
  unanswered?: boolean;
}

/** Composio didn't answer, or answered something connect can't use. */
export class ComposioError extends Error {
  /** Composio's HTTP status, when it answered with one. */
  readonly status: number | undefined;
  /**
   * Composio's name for the error, such as
   * `ConnectedAccount_CredentialValidationRejected`, when its answer gave
   * one (`error.slug`): only that, never its message, which may repeat
   * what was sent.
   */
  readonly slug: string | undefined;
  /**
   * Composio's number for the error, such as 1803, when its answer gave
   * one (`error.code`): a stable machine code, safe to name for support.
   */
  readonly code: number | undefined;
  /**
   * Composio didn't answer at all: the request failed on the way, or took
   * longer than it may. Asking again may get an answer.
   */
  readonly unanswered: boolean;

  constructor(message: string, failure: ComposioFailure = {}) {
    super(message, { cause: failure.cause });
    this.name = "ComposioError";
    this.status = failure.status;
    this.slug = failure.slug;
    this.code = failure.code;
    this.unanswered = failure.unanswered ?? false;
  }
}

/** Connect's Composio key, or `undefined` while it is unset. */
export const composioKey = (env: Env): string | undefined =>
  env.COMPOSIO_API_KEY === undefined || env.COMPOSIO_API_KEY === ""
    ? undefined
    : env.COMPOSIO_API_KEY;

/**
 * The body's bytes, read up to `maxBytes` as they arrive: one byte more
 * is a {@link ComposioError}, whatever `content-length` said, and a body
 * that breaks off or runs out of time is one that is `unanswered`. The
 * body is cancelled once read, or once refused.
 */
export const readCappedBytes = async (
  response: Response,
  maxBytes: number
): Promise<Uint8Array> => {
  const reader = response.body?.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array> | undefined;
      try {
        // oxlint-disable-next-line no-await-in-loop -- a stream is read in order
        chunk = await reader?.read();
      } catch (error) {
        // The answer broke off, or ran out of time, on the way: asking
        // again may get all of it.
        throw new ComposioError("Composio's answer broke off", {
          cause: error,
          unanswered: true,
        });
      }
      if (chunk === undefined || chunk.done) {
        break;
      }
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) {
        throw new ComposioError("The answer isn't a byte stream");
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new ComposioError(`The answer is over ${maxBytes} bytes`);
      }
      parts.push(value);
    }
  } finally {
    // Never in place of the error that ended the read.
    await reader?.cancel().catch((error: unknown) => {
      log.warn("composio.cancel_failed", errorFields(error));
    });
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return body;
};

/** Largest error answer connect reads, for its slug and code alone. */
const maxErrorBytes = 64 * 1024;

/**
 * Composio's error answer, of which only its machine names are read: the
 * slug and the number (`code`), never its message.
 */
const errorAnswerSchema = z.object({
  error: z.object({
    slug: z.unknown().optional(),
    code: z.unknown().optional(),
  }),
});

/**
 * A slug of Composio's: a machine name such as
 * `ConnectedAccount_CredentialValidationRejected`, letters, digits and
 * underscores starting with a letter, never text.
 */
const errorSlugSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/u);

/** A number of Composio's for an error. */
const errorCodeSchema = z.number().int().min(0).max(999_999);

/**
 * The slug and code of Composio's error answer `response`, those it has
 * that connect can read: anything else, a body that fails or runs over
 * `maxErrorBytes` included, is neither. The body is cancelled either way.
 */
const errorNamesOf = async (
  response: Response
): Promise<{ slug?: string; code?: number }> => {
  try {
    const text = new TextDecoder().decode(
      await readCappedBytes(response, maxErrorBytes)
    );
    const named = errorAnswerSchema.safeParse(JSON.parse(text)).data?.error;
    const slug = errorSlugSchema.safeParse(named?.slug);
    const code = errorCodeSchema.safeParse(named?.code);
    return {
      ...(slug.success ? { slug: slug.data } : {}),
      ...(code.success ? { code: code.data } : {}),
    };
  } catch {
    return {};
  }
};

/** One request to Composio's API. */
export interface ComposioRequest<Schema extends z.ZodType> {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** The path under the API's base, with its query, such as `/toolkits`. */
  path: string;
  body?: object;
  /** What the answer must be. */
  schema: Schema;
  /** How long it may take, if less than `requestTimeoutMs`. */
  timeoutMs?: number;
}

/**
 * Sends one request to Composio's API with `key`, and returns its answer,
 * validated by `schema`. Throws {@link ComposioError} when Composio doesn't
 * answer, answers with an error or redirect, or answers something else.
 * Logs the method, the path's first segment and the status only: never the
 * key, the query or a body.
 */
export const composioRequest = async <Schema extends z.ZodType>(
  key: string,
  {
    method = "GET",
    path,
    body,
    schema,
    timeoutMs = requestTimeoutMs,
  }: ComposioRequest<Schema>
): Promise<z.infer<Schema>> => {
  const url = new URL(`${composioApiBase}${path}`);
  const [, area = ""] = path.split(/[/?]/u);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        "x-api-key": key,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A redirect could carry the key to another host: never follow.
      redirect: "manual",
      signal: AbortSignal.timeout(Math.min(timeoutMs, requestTimeoutMs)),
    });
  } catch (error) {
    log.warn("composio.failed", { method, area, ...errorFields(error) });
    throw new ComposioError("Composio didn't answer", {
      cause: error,
      unanswered: true,
    });
  }
  log.info("composio.request", { method, area, status: response.status });
  if (!response.ok) {
    throw new ComposioError(`Composio answered ${response.status}`, {
      status: response.status,
      ...(await errorNamesOf(response)),
    });
  }
  let parsed: unknown;
  try {
    const text = new TextDecoder().decode(
      await readCappedBytes(response, maxResponseBytes)
    );
    parsed = text === "" ? null : JSON.parse(text);
  } catch (error) {
    throw error instanceof ComposioError
      ? error
      : new ComposioError("Composio's answer isn't JSON", { cause: error });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ComposioError("Composio's answer isn't one connect can read");
  }
  return result.data;
};
