/**
 * The Cloudflare API as the real-account qualification (run.ts) reaches
 * it: every call recorded in the run's evidence (method, path, status,
 * Cloudflare's error codes; never a body, a header or the token), and
 * every write refused unless it names something of the run's own (its
 * prefix, or an id the run created), so a run can't touch anything else
 * in the account, whatever the token allows. Without `live`, a write is
 * recorded as planned and not sent.
 */
import { appendFileSync } from "node:fs";

import { z } from "zod";

const apiBase = "https://api.cloudflare.com/client/v4";

/** Cloudflare's envelope; `errors` is null on some successes (GRA-430). */
const envelopeSchema = z.object({
  success: z.boolean(),
  errors: z
    .array(z.object({ code: z.number(), message: z.string() }))
    .nullable()
    .transform((errors) => errors ?? []),
  result: z.unknown(),
});

/** A refused or failed call, with Cloudflare's codes and messages. */
export class CloudflareError extends Error {
  readonly status: number;
  readonly codes: readonly number[];

  constructor(
    method: string,
    path: string,
    status: number,
    errors: readonly { code: number; message: string }[]
  ) {
    super(
      `${method} ${path}: ${status} ${errors.map(({ code, message }) => `${code} ${message}`).join("; ")}`
    );
    this.name = "CloudflareError";
    this.status = status;
    this.codes = errors.map(({ code }) => code);
  }
}

/** The name of the error a dry run's write throws instead of sending it. */
export const plannedWriteError = "PlannedWriteError";

/** A write a dry run didn't send. */
const plannedWrite = (method: string, path: string): Error => {
  const error = new Error(`Planned, not sent (no --live): ${method} ${path}`);
  error.name = plannedWriteError;
  return error;
};

/** One line of the run's evidence. */
export type Evidence = Record<string, unknown> & { kind: string };

/** Appends to the evidence file, one JSON line each, with the time. */
export const evidenceLog =
  (file: string) =>
  (entry: Evidence): void => {
    appendFileSync(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      { mode: 0o600 }
    );
  };

export interface ApiOptions {
  accountId: string;
  token: string;
  /** What every resource the run writes is named after: `qual-<date>`. */
  prefix: string;
  live: boolean;
  record: (entry: Evidence) => void;
  fetch?: typeof fetch;
}

export interface Call {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Below the account: `/workers/scripts`, say. */
  path: string;
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
}

/** The path segments a resource's name or id follows. */
const collections: ReadonlySet<string> = new Set([
  "scripts",
  "namespaces",
  "database",
  "buckets",
]);

/** A name or id as the run makes them: no slash, dot or anything encoded. */
const plainSegment = /^[A-Za-z0-9_-]+$/u;

/**
 * Whether a write to `path` names only what's the run's: every resource
 * it names (the segment after `scripts`, `namespaces`, `database` or
 * `buckets`) starts with the run's prefix or is an id the run created,
 * and it names at least one.
 */
export const namesOwn = (
  path: string,
  prefix: string,
  created: ReadonlySet<string>
): boolean => {
  const segments = (path.split("?")[0] ?? "").split("/");
  const named = segments.filter(
    (_, index) => index > 0 && collections.has(segments[index - 1] ?? "")
  );
  return (
    named.length > 0 &&
    named.every(
      (segment) =>
        plainSegment.test(segment) &&
        (segment.startsWith(prefix) || created.has(segment))
    )
  );
};

/** The run's API client: `call` for one request, `own` for an id the run made. */
export const cloudflareApi = (options: ApiOptions) => {
  const { accountId, token, prefix, live, record } = options;
  const send = options.fetch ?? fetch;
  const created = new Set<string>();

  const call = async <T>(
    { method, path, json, form, headers }: Call,
    schema: z.ZodType<T>,
    { creates }: { creates?: string } = {}
  ): Promise<T> => {
    const write = method !== "GET";
    // A create names its resource in its body: `creates` is that name,
    // which must be the run's too.
    const owned =
      creates === undefined
        ? namesOwn(path, prefix, created)
        : creates.startsWith(prefix);
    if (write && !owned) {
      record({ kind: "refused", method, path });
      throw new Error(
        `Refused: ${method} ${path} names nothing of run ${prefix}`
      );
    }
    if (write && !live) {
      record({ kind: "planned", method, path });
      throw plannedWrite(method, path);
    }
    const response = await send(`${apiBase}/accounts/${accountId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(json === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: form ?? (json === undefined ? undefined : JSON.stringify(json)),
    });
    const text = await response.text();
    const parsed = envelopeSchema.safeParse(
      text === ""
        ? { success: response.ok, errors: [], result: null }
        : JSON.parse(text)
    );
    const errors = parsed.success ? parsed.data.errors : [];
    record({
      kind: "call",
      method,
      path,
      status: response.status,
      codes: errors.map(({ code }) => code),
    });
    if (!(response.ok && parsed.success && parsed.data.success)) {
      throw new CloudflareError(method, path, response.status, errors);
    }
    return schema.parse(parsed.data.result);
  };

  return {
    call,
    /** Marks `id` as the run's own, so later writes may name it. */
    own: (id: string): void => {
      created.add(id);
    },
  };
};

export type CloudflareApi = ReturnType<typeof cloudflareApi>;

/** The token itself, checked: `GET /user/tokens/verify`, outside any account. */
export const verifyToken = async (
  token: string,
  send: typeof fetch = fetch
): Promise<{ id: string; status: string }> => {
  const response = await send(`${apiBase}/user/tokens/verify`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = envelopeSchema.parse(await response.json());
  if (!body.success) {
    throw new CloudflareError(
      "GET",
      "/user/tokens/verify",
      response.status,
      body.errors
    );
  }
  return z.object({ id: z.string(), status: z.string() }).parse(body.result);
};
