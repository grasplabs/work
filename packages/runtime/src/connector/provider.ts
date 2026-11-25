import type { z } from "zod";

import { egressHeader, egressKind, maxRetryAfterSeconds } from "./manifest.ts";
import { invalidCode, isWriteMethod as isWrite, ToolError } from "./server.ts";

// How a connector's tools reach their provider: plain `fetch` through
// connect's egress, and a provider's answer that isn't a success turned
// into a ToolError with a code callers can act on. The provider's messages
// aren't passed on, since they can repeat what was sent; its error code is.

/** What sets a provider's errors apart from another's. */
export interface ProviderDefinition {
  /** Its name, as the errors a caller sees name it: `Microsoft 365`. */
  name: string;
  /** The code or reason an error answer's JSON names, if it names one. */
  errorCodeOf: (body: unknown) => string | undefined;
  /** Whether an answer other than a 429 is a rate limit, by its status and code. */
  isThrottled?: (status: number, code: string | undefined) => boolean;
  /** The statuses by which it refuses a request as not valid. */
  invalidStatuses: readonly number[];
}

/** Sending requests to one provider. */
export interface Provider {
  /** Sends one request: its answer if it succeeded, else a ToolError. */
  fetch: (url: URL, init?: RequestInit) => Promise<Response>;
  /** Its JSON answer, checked against what the tool expects of it. */
  json: <Schema extends z.ZodType>(
    url: URL,
    schema: Schema,
    init?: RequestInit
  ) => Promise<z.output<Schema>>;
  /**
   * The ToolError an answer that isn't a success stands for, to a GET: for
   * code that looks at the answer itself first (a sync, whose cursor a
   * 404 or 410 says is gone).
   */
  failure: (response: Response) => Promise<ToolError>;
}

/** One segment of a path, encoded. */
export const segment = (value: string): string => encodeURIComponent(value);

/** Sends JSON. */
export const jsonBody = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Wait a throttled answer asks for when it doesn't say, in seconds. */
const defaultRetryAfterSeconds = 60;

/**
 * An HTTP-date in IMF-fixdate and the obsolete RFC 850 form, which a
 * recipient must accept too (RFC 9110, section 5.6.7), as asctime's.
 */
const httpDates = [
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u,
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/u,
];

/** The asctime form, which names no zone: it is in GMT, as the others. */
const asctimeDate =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:\d{2}| \d) \d{2}:\d{2}:\d{2} \d{4}$/u;

/**
 * The seconds a `retry-after` header asks for, if it gives them: as
 * seconds, or as the HTTP date to wait until; at most an hour. A value
 * that is neither is ignored, as RFC 9110 says.
 */
export const retryAfterOf = (response: Response): number | undefined => {
  const value = response.headers.get("retry-after")?.trim() ?? "";
  if (/^\d+$/u.test(value)) {
    return Math.min(Number(value), maxRetryAfterSeconds);
  }
  let date: string;
  if (httpDates.some((form) => form.test(value))) {
    date = value;
  } else if (asctimeDate.test(value)) {
    date = `${value} GMT`;
  } else {
    return undefined;
  }
  const seconds = Math.ceil((Date.parse(date) - Date.now()) / 1000);
  return Number.isNaN(seconds)
    ? undefined
    : Math.min(Math.max(seconds, 0), maxRetryAfterSeconds);
};

/** Providers' error codes and reasons are identifiers, such as `notFound`. */
const providerErrorCode = /^[A-Za-z][\w.]{0,63}$/u;

/**
 * The error connect's egress's own answer stands for. A refused request
 * never left; one whose answer the egress withheld (the provider was
 * unreachable, timed out, or redirected) may have reached the provider, so
 * a write's outcome is unknown.
 */
const egressFailure = (
  kind: string,
  name: string,
  method: string
): ToolError => {
  switch (kind) {
    case egressKind.refused: {
      return new ToolError("Connect's egress refused the request", {
        code: "egress_refused",
      });
    }
    default: {
      return new ToolError(`Connect's egress withheld ${name}'s answer`, {
        code: "egress_failed",
        outcomeUnknown: isWrite(method),
      });
    }
  }
};

/**
 * The error an answer that isn't a success stands for.
 *
 * Throttling (429, or what `isThrottled` says is a rate limit) means the
 * provider did nothing, and a 503 to a read changes nothing either: both
 * say the call did nothing (`notPerformed`), so a write's idempotency key
 * is free again and the caller may try again. That holds for the whole
 * call because every tool sends at most one write, as its last request:
 * nothing of the call went through before it. A 503 to a write may come
 * after the provider acted, so it isn't marked: like every 5xx to a write,
 * it leaves the write's outcome unknown (`outcomeUnknown`), never a failure
 * that says nothing happened. A 4xx refuses the request before acting.
 */
const failureOf = async (
  { name, errorCodeOf, isThrottled, invalidStatuses }: ProviderDefinition,
  response: Response,
  method: string
): Promise<ToolError> => {
  // Connect's egress, not the provider, answered: a request the
  // connector's routes don't allow (a bug of ours), or a withheld answer.
  const egress = response.headers.get(egressHeader);
  if (egress !== null) {
    await response.body?.cancel();
    return egressFailure(egress, name, method);
  }
  const retryAfterSeconds = retryAfterOf(response);
  let code: string | undefined;
  try {
    code = errorCodeOf(await response.json());
  } catch {
    code = undefined;
  }
  if (code !== undefined && !providerErrorCode.test(code)) {
    code = undefined;
  }
  const named = code === undefined ? "" : ` (${code})`;
  const { status } = response;
  // A 403 that names a wait is a rate limit, as connect's egress pauses
  // the connection for it.
  if (
    status === 429 ||
    (status === 403 && retryAfterSeconds !== undefined) ||
    isThrottled?.(status, code) === true
  ) {
    return new ToolError(
      `${name} is rate limiting requests: nothing was done. Try again later.`,
      {
        code: "throttled",
        retryAfterSeconds: retryAfterSeconds ?? defaultRetryAfterSeconds,
        notPerformed: true,
      }
    );
  }
  if (status === 503) {
    return new ToolError(`${name} is unavailable. Try again later.`, {
      code: "unavailable",
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      notPerformed: !isWrite(method),
      outcomeUnknown: isWrite(method),
    });
  }
  if (status === 401 || status === 403) {
    return new ToolError(`${name} refused access${named}`, {
      code: "access_denied",
    });
  }
  if (status === 404) {
    return new ToolError(`${name} has no such item${named}`, {
      code: "not_found",
    });
  }
  if (invalidStatuses.includes(status)) {
    return new ToolError(`${name} refused the request${named}`, {
      code: invalidCode,
    });
  }
  return new ToolError(`${name} answered ${status}${named}`, {
    code: "failed",
    outcomeUnknown: status >= 500 && isWrite(method),
  });
};

/** Sending requests to the provider `definition` describes. */
export const providerFetch = (definition: ProviderDefinition): Provider => {
  const send = async (url: URL, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? "GET";
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (!isWrite(method)) {
        throw error;
      }
      // Sent, maybe taken, and its answer never came back.
      throw new ToolError(
        `${definition.name}'s answer was lost: whether it acted is unknown`,
        { code: "egress_failed", outcomeUnknown: true }
      );
    }
    if (!response.ok) {
      throw await failureOf(definition, response, method);
    }
    return response;
  };
  return {
    fetch: send,
    failure: async (response) => await failureOf(definition, response, "GET"),
    json: async (url, schema, init) => {
      const response = await send(url, init);
      let body: unknown;
      let read = true;
      try {
        body = await response.json();
      } catch {
        // Not JSON, or past connect's egress's size limit.
        read = false;
      }
      const parsed = read ? schema.safeParse(body) : undefined;
      if (parsed?.success === true) {
        return parsed.data;
      }
      const message = `${definition.name}'s answer isn't what the connector expects`;
      // The provider took the write: it went through, and what it made
      // can't be told.
      if (isWrite(init?.method ?? "GET")) {
        throw new ToolError(message, { code: "failed", outcomeUnknown: true });
      }
      throw new Error(message);
    },
  };
};
