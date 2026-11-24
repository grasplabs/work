/**
 * OSV.dev's batch query (https://api.osv.dev/v1/querybatch), as strict as
 * the real one where Grasp depends on it: a POST of `{ queries }`, each an
 * npm package by name and an exact version, at most 1000; one result per
 * query, in order, each `{ vulns: [{ id, modified }] }` or `{}` when it
 * knows none, and `next_page_token` when a version's entries go on past
 * a page, which a query's `page_token` asks for next; a 400 for a body it
 * doesn't take. A test reports versions
 * as malware (`MAL-…`) or with other entries (`GHSA-…`), makes OSV answer
 * something else, and reads back what was asked.
 *
 * Self-contained, with nothing from outside the function: core's tests
 * run it inside the Worker that stands in for the internet behind connect
 * (core's test/connect-providers.ts embeds its source), connect's call it
 * straight from a fetch spy.
 */
/* oxlint-disable unicorn/consistent-function-scoping */
export const osvFake = () => {
  const origin = "https://api.osv.dev";
  /** Entry IDs by `name@version`. */
  const entries = new Map<string, string[]>();
  const asked: {
    method: string;
    path: string;
    body: string;
    headers: Record<string, string>;
    redirect: string;
  }[] = [];
  let override: (() => Response) | undefined;
  /** Most entries of one version OSV sends on one page. */
  let perPage = 1000;
  /** What OSV answers a batch naming the package, instead of its own. */
  const failing = new Map<string, () => Response>();

  const badRequest = (message: string): Response =>
    Response.json({ code: 3, message }, { status: 400 });

  /** `value`'s own `key`, when `value` is an object. */
  const fieldOf = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null && Object.hasOwn(value, key)
      ? Reflect.get(value, key)
      : undefined;

  /** The queries a body holds, as OSV takes them, or why not. */
  const queriesOf = (
    body: unknown
  ):
    | { name: string; version: string; pageToken: string | undefined }[]
    | string => {
    if (typeof body !== "object" || body === null || !("queries" in body)) {
      return "Missing queries";
    }
    const { queries } = body;
    if (!Array.isArray(queries) || queries.length > 1000) {
      return "Too many queries";
    }
    const read: {
      name: string;
      version: string;
      pageToken: string | undefined;
    }[] = [];
    const listed: unknown[] = queries;
    for (const query of listed) {
      const pkg = fieldOf(query, "package");
      const name = fieldOf(pkg, "name");
      const version = fieldOf(query, "version");
      const pageToken = fieldOf(query, "page_token");
      if (
        fieldOf(pkg, "ecosystem") !== "npm" ||
        typeof name !== "string" ||
        typeof version !== "string" ||
        (pageToken !== undefined && typeof pageToken !== "string")
      ) {
        return "Invalid query";
      }
      read.push({ name, version, pageToken });
    }
    return read;
  };

  const answer = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const body = await request.text();
    asked.push({
      method: request.method,
      path: url.pathname,
      body,
      headers: Object.fromEntries(request.headers),
      redirect: request.redirect,
    });
    if (override !== undefined) {
      return override();
    }
    if (request.method !== "POST" || url.pathname !== "/v1/querybatch") {
      return Response.json({ code: 5, message: "Not found" }, { status: 404 });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return badRequest("Invalid JSON");
    }
    const queries = queriesOf(parsed);
    if (typeof queries === "string") {
      return badRequest(queries);
    }
    for (const { name } of queries) {
      const respond = failing.get(name);
      if (respond !== undefined) {
        return respond();
      }
    }
    return Response.json({
      results: queries.map(({ name, version, pageToken }) => {
        const known = entries.get(`${name}@${version}`);
        if (known === undefined) {
          return {};
        }
        const from = Number(pageToken ?? "0");
        const page = known.slice(from, from + perPage);
        return {
          vulns: page.map((id) => ({
            id,
            modified: "2026-10-19T06:45:05.370871Z",
          })),
          ...(from + perPage < known.length
            ? { next_page_token: String(from + perPage) }
            : {}),
        };
      }),
    });
  };

  return {
    origin,
    asked,
    /** OSV knows the entry `id` (`MAL-…`, `GHSA-…`) for `name@version`. */
    report: (name: string, version: string, id: string): void => {
      const key = `${name}@${version}`;
      entries.set(key, [...(entries.get(key) ?? []), id]);
    },
    /** Answers every request with what `respond` makes, instead of OSV's own. */
    override: (respond: (() => Response) | undefined): void => {
      override = respond;
    },
    /**
     * Answers a batch that names `name` with what `respond` makes, or with
     * OSV's own answers again for `undefined`: other batches as ever.
     */
    failFor: (name: string, respond: (() => Response) | undefined): void => {
      if (respond === undefined) {
        failing.delete(name);
      } else {
        failing.set(name, respond);
      }
    },
    /** Sends at most `entries` of one version's entries on a page. */
    pageSize: (most: number): void => {
      perPage = most;
    },
    answer,
    /** Forgets everything reported, overridden and asked. */
    reset: (): void => {
      entries.clear();
      failing.clear();
      perPage = 1000;
      override = undefined;
      asked.length = 0;
    },
  };
};
