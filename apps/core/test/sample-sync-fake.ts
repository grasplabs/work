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
 * The sample provider's feeds, as the sample sync connector reads them
 * (apps/connect/test/fixtures/sample-sync-connector.ts): its `files`
 * sync's change feed (`GET /v1/me/changes?from=<position>`), and its
 * `folders` sync's places (`GET /v1/me/folders`, failing while the test
 * sets none) with each folder's change feed, names-only listing and items
 * by ID. Only for an account a test set a world for, by the token connect
 * sends; a position with no page answers 410, which the connector takes
 * as "restart"; an item asked by ID that isn't there comes as gone.
 *
 * A test POSTs `{ subject, pages?, places?, folders?, failing? }` to the
 * control URL: what it names replaces that part of the account's world;
 * `folders` maps each folder to `{ changes, names, items }`, its pages by
 * position and its items by ID; a folder in `failing` answers 500, and so
 * does the `files` feed while `failing` names `files`. Every
 * items request is kept, by folder: GET the control URL with `subject`
 * and `folder` for them.
 *
 * Self-contained, with nothing from outside the function: core's tests
 * run it inside the Worker that stands in for the internet behind connect
 * (test/connect-providers.ts embeds its source).
 */
export const sampleSyncFake = () => {
  const worlds = new Map<string, Record<string, unknown>>();
  const fetched = new Map<string, string[][]>();
  const tokenPattern = /^Bearer access\.(?<subject>.+)$/u;
  const folderPattern =
    /^\/v1\/me\/folders\/(?<folder>[^/]+)\/(?<what>changes|names|items)$/u;
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const field = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null
      ? Reflect.get(value, key)
      : undefined;
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const pageOr410 = (page: unknown): Response =>
    page === undefined
      ? new Response(null, { status: 410 })
      : Response.json(page);
  /** One folder's answer: its feed's or listing's page, or its items by ID. */
  const folderAnswer = (
    world: Record<string, unknown>,
    subject: string,
    folder: string,
    what: string,
    url: URL
  ): Response => {
    const failing = field(world, "failing");
    if (Array.isArray(failing) && failing.includes(folder)) {
      return new Response(null, { status: 500 });
    }
    const held = field(field(world, "folders"), folder);
    if (what !== "items") {
      return pageOr410(
        field(field(held, what), url.searchParams.get("from") ?? "")
      );
    }
    const ids = url.searchParams.getAll("id");
    const key = `${subject} ${folder}`;
    fetched.set(key, [...(fetched.get(key) ?? []), ids]);
    return Response.json({
      changes: ids.map(
        (id) =>
          field(field(held, "items"), id) ?? { gone: true, id, kind: "mail" }
      ),
      next: "items",
      more: false,
    });
  };
  return {
    control: async (request: Request): Promise<Response> => {
      if (request.method === "GET") {
        const url = new URL(request.url);
        const key = `${url.searchParams.get("subject") ?? ""} ${url.searchParams.get("folder") ?? ""}`;
        return Response.json(fetched.get(key) ?? []);
      }
      const posted: unknown = await request.json();
      const subject = field(posted, "subject");
      if (typeof subject !== "string") {
        return new Response(null, { status: 400 });
      }
      const world = worlds.get(subject) ?? {};
      for (const part of ["pages", "places", "folders", "failing"]) {
        const value = field(posted, part);
        if (value !== undefined) {
          world[part] = value;
        }
      }
      worlds.set(subject, world);
      return new Response(null, { status: 204 });
    },
    answer: (request: Request, url: URL): Response | undefined => {
      if (url.hostname !== "api.sample.test") {
        return undefined;
      }
      const subject =
        tokenPattern.exec(request.headers.get("authorization") ?? "")?.groups
          ?.subject ?? "";
      const world = worlds.get(subject);
      if (world === undefined) {
        return undefined;
      }
      if (url.pathname === "/v1/me/changes") {
        const failing = field(world, "failing");
        if (Array.isArray(failing) && failing.includes("files")) {
          return new Response(null, { status: 500 });
        }
        return pageOr410(
          field(field(world, "pages"), url.searchParams.get("from") ?? "")
        );
      }
      if (url.pathname === "/v1/me/folders") {
        const places = field(world, "places");
        return Array.isArray(places)
          ? Response.json({ folders: places })
          : new Response(null, { status: 500 });
      }
      const matched = folderPattern.exec(url.pathname)?.groups;
      if (matched?.folder === undefined || matched.what === undefined) {
        return undefined;
      }
      return folderAnswer(
        world,
        subject,
        decodeURIComponent(matched.folder),
        matched.what,
        url
      );
    },
  };
};
