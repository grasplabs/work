/**
 * Where tests set a person's Google Drive for native sync
 * (brain-sync.test.ts): POST `{ subject, drive }`, the Google account's
 * subject (its token is `access.<subject>`, test/connect-providers.ts) and
 * what its Drive holds (`DriveWorld`).
 */
export const driveSyncControlUrl = "https://drive-control.test/drive";

/** A file as Drive v3 lists it, with the fields the sync asks for. */
export type DriveFile = Record<string, unknown> & { id: string };

/** What one person's Drive holds, as the test sets it. */
export interface DriveWorld {
  /** Where the change feed stands before a listing starts. */
  start: string;
  /** Every file the person owns, in listing order. */
  owned: DriveFile[];
  /** The change feed, by page token: a token not here answers 404. */
  changes: Record<string, Record<string, unknown>>;
  /** Each file's content, by ID: exported text or its own bytes. */
  contents: Record<string, string>;
  /** Seconds a 429 asks to wait for every read, when set. */
  throttle?: number;
}

/**
 * Google Drive v3 as the Google Workspace connector's sync reads it
 * (packages/connectors/google-workspace/src/drive-sync.ts): the change
 * feed's start, the listing of what the person owns, the change feed, and
 * each file's export or bytes. It answers only for an account a test set
 * a Drive for, by the token connect sends, so every other test's Google
 * stays as it was.
 *
 * Self-contained, with nothing from outside the function: core's tests
 * run it inside the Worker that stands in for the internet behind connect
 * (test/connect-providers.ts embeds its source).
 */
export const driveSyncFake = () => {
  /** Each Drive as a test posted it: a `DriveWorld`, read field by field. */
  const worlds = new Map<string, object>();
  const tokenPattern = /^Bearer access\.(?<subject>.+)$/u;
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const notFound = () =>
    Response.json({ error: { code: 404 } }, { status: 404 });
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const field = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null
      ? Reflect.get(value, key)
      : undefined;
  return {
    control: async (request: Request): Promise<Response> => {
      const posted: unknown = await request.json();
      const subject = field(posted, "subject");
      const drive = field(posted, "drive");
      if (
        typeof subject !== "string" ||
        typeof drive !== "object" ||
        drive === null
      ) {
        return new Response(null, { status: 400 });
      }
      worlds.set(subject, drive);
      return new Response(null, { status: 204 });
    },
    answer: (request: Request, url: URL): Response | undefined => {
      if (
        url.hostname !== "www.googleapis.com" ||
        !url.pathname.startsWith("/drive/v3/")
      ) {
        return undefined;
      }
      const subject =
        tokenPattern.exec(request.headers.get("authorization") ?? "")?.groups
          ?.subject ?? "";
      const world = worlds.get(subject);
      if (world === undefined) {
        return undefined;
      }
      const throttle = field(world, "throttle");
      if (typeof throttle === "number") {
        return Response.json(
          { error: { code: 429, errors: [{ reason: "rateLimitExceeded" }] } },
          { status: 429, headers: { "retry-after": String(throttle) } }
        );
      }
      const path = url.pathname;
      if (path === "/drive/v3/changes/startPageToken") {
        return Response.json({ startPageToken: field(world, "start") });
      }
      if (path === "/drive/v3/changes") {
        const page = field(
          field(world, "changes"),
          url.searchParams.get("pageToken") ?? ""
        );
        return page === undefined ? notFound() : Response.json(page);
      }
      if (path === "/drive/v3/files") {
        const owned = field(world, "owned");
        const files: unknown[] = Array.isArray(owned) ? owned : [];
        const size = Number(url.searchParams.get("pageSize") ?? 100);
        const from = Number(url.searchParams.get("pageToken") ?? 0);
        const next = from + size;
        return Response.json({
          files: files.slice(from, next),
          ...(next < files.length ? { nextPageToken: String(next) } : {}),
        });
      }
      const [id] = path.slice("/drive/v3/files/".length).split("/");
      const content = field(
        field(world, "contents"),
        decodeURIComponent(id ?? "")
      );
      return typeof content === "string" ? new Response(content) : notFound();
    },
  };
};
