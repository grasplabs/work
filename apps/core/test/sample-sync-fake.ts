/**
 * Where tests set what connect's sample sync connector reads
 * (apps/connect/test/fixtures/sample-sync-connector.ts) for one account:
 * POST `{ subject, pages }`, the account's subject (its token is
 * `access.<subject>`, test/connect-providers.ts) and its change feed's
 * pages by the position each is read from (`""` for the first), each
 * `{ changes, next, more }` of neutral sync items.
 */
export const sampleSyncControlUrl = "https://sample-sync-control.test/feed";

/**
 * The sample provider's change feed, as the sample sync connector reads it
 * (`GET /v1/me/changes?from=<position>`): only for an account a test set
 * pages for, by the token connect sends; a position it has no page for
 * answers 410, which the connector takes as "restart".
 *
 * Self-contained, with nothing from outside the function: core's tests
 * run it inside the Worker that stands in for the internet behind connect
 * (test/connect-providers.ts embeds its source).
 */
export const sampleSyncFake = () => {
  const feeds = new Map<string, object>();
  const tokenPattern = /^Bearer access\.(?<subject>.+)$/u;
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const field = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null
      ? Reflect.get(value, key)
      : undefined;
  return {
    control: async (request: Request): Promise<Response> => {
      const posted: unknown = await request.json();
      const subject = field(posted, "subject");
      const pages = field(posted, "pages");
      if (
        typeof subject !== "string" ||
        typeof pages !== "object" ||
        pages === null
      ) {
        return new Response(null, { status: 400 });
      }
      feeds.set(subject, pages);
      return new Response(null, { status: 204 });
    },
    answer: (request: Request, url: URL): Response | undefined => {
      if (
        url.hostname !== "api.sample.test" ||
        url.pathname !== "/v1/me/changes"
      ) {
        return undefined;
      }
      const subject =
        tokenPattern.exec(request.headers.get("authorization") ?? "")?.groups
          ?.subject ?? "";
      const pages = feeds.get(subject);
      if (pages === undefined) {
        return undefined;
      }
      const page = field(pages, url.searchParams.get("from") ?? "");
      return page === undefined
        ? new Response(null, { status: 410 })
        : Response.json(page);
    },
  };
};
