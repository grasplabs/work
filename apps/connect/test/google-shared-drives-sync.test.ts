import { connectionErrors } from "@grasp-os/shared/connect";
import { roleErrors } from "@grasp-os/shared/roles";
import { syncErrors } from "@grasp-os/shared/sync";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { connectAccount, mailboxAccount, someone } from "./connect.ts";
import { scopeRefusal, syncGrant } from "./google-scopes.ts";
import { fakeInternet } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";

// The Google Workspace connector's sync of a shared connection's picked
// shared drives (shared-drive-sync.ts), through connect's real read
// (src/sync.ts) with Google mocked at its host. The mocked Drive follows
// the reference pages: each method answers only the query options its
// page lists, a shared drive's files only with `supportsAllDrives`, and a
// listing of one drive only with `corpora=drive`, its `driveId` and
// `includeItemsFromAllDrives`. The ways it can fail come first: a drive
// nobody picked read; the connected account's own Drive read through a
// shared connection; a file that left the drive, went to the bin or was
// deleted kept; a drive the account no longer sees read at all; the
// drive's own members taken as the readers.

const providers = fakeProviders();

const apisHost = "www.googleapis.com";
const pdf = "application/pdf";

/** Google's standard parameters, which every method takes. */
const standard = new Set(["fields", "alt", "prettyPrint", "quotaUser", "key"]);

/**
 * The query options each method's reference page lists, by path pattern:
 * any other is refused, as an unknown option is a mistake here.
 */
const documented: readonly { path: RegExp; options: readonly string[] }[] = [
  // https://developers.google.com/workspace/drive/api/reference/rest/v3/drives/list
  {
    path: /^\/drive\/v3\/drives$/u,
    options: ["pageSize", "pageToken", "q", "useDomainAdminAccess"],
  },
  // https://developers.google.com/workspace/drive/api/reference/rest/v3/drives/get
  { path: /^\/drive\/v3\/drives\/[^/]+$/u, options: ["useDomainAdminAccess"] },
  // https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/getStartPageToken
  {
    path: /^\/drive\/v3\/changes\/startPageToken$/u,
    options: ["driveId", "supportsAllDrives"],
  },
  // https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list
  {
    path: /^\/drive\/v3\/changes$/u,
    options: [
      "pageToken",
      "driveId",
      "includeItemsFromAllDrives",
      "supportsAllDrives",
      "includeRemoved",
      "restrictToMyDrive",
      "pageSize",
      "spaces",
      "includeCorpusRemovals",
      "includePermissionsForView",
      "includeLabels",
    ],
  },
  // https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list
  {
    path: /^\/drive\/v3\/files$/u,
    options: [
      "corpora",
      "driveId",
      "includeItemsFromAllDrives",
      "supportsAllDrives",
      "orderBy",
      "pageSize",
      "pageToken",
      "q",
      "spaces",
      "includePermissionsForView",
      "includeLabels",
    ],
  },
  // https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export
  { path: /^\/drive\/v3\/files\/[^/]+\/export$/u, options: ["mimeType"] },
  // https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get
  {
    path: /^\/drive\/v3\/files\/[^/]+$/u,
    options: [
      "acknowledgeAbuse",
      "supportsAllDrives",
      "includePermissionsForView",
      "includeLabels",
    ],
  },
];

const badRequest = (message: string): Response =>
  Response.json({ error: { code: 400, message } }, { status: 400 });

const notFound = (): Response =>
  Response.json({ error: { code: 404 } }, { status: 404 });

type DriveFile = Record<string, unknown> & {
  id: string;
  driveId?: string;
};

/** What Google holds, for each test to set. */
interface Google {
  /** The shared drives the account is a member of, in Google's order. */
  drives: { id: string; name: string }[];
  /** Every file, in listing order: shared drives' (`driveId`) and the account's own. */
  files: DriveFile[];
  /** Each shared drive's change feed, by page token. */
  changes: Record<string, Record<string, unknown>>;
  /** Each file's content, by ID. */
  contents: Record<string, string>;
}

const google: Google = { drives: [], files: [], changes: {}, contents: {} };

const sales = { id: "drive-sales", name: "Sales" };
const legal = { id: "drive-legal", name: "Legal" };

/** A file of a shared drive. */
const fileIn = (
  driveId: string,
  id: string,
  fields: Record<string, unknown> = {}
): DriveFile => ({
  id,
  name: `${id}.pdf`,
  mimeType: pdf,
  size: "8",
  modifiedTime: "2026-11-10T09:00:00.000Z",
  version: "3",
  driveId,
  lastModifyingUser: { emailAddress: "Owner@Acme.test" },
  ...fields,
});

/** A file of the connected account's own My Drive. */
const ownFile: DriveFile = {
  id: "own-notes",
  name: "Notes",
  mimeType: pdf,
  size: "8",
  modifiedTime: "2026-11-10T09:00:00.000Z",
  version: "1",
  ownedByMe: true,
};

const reset = (): void => {
  google.drives = [sales, legal];
  google.files = [
    fileIn(sales.id, "price-list"),
    fileIn(sales.id, "contract"),
    fileIn(legal.id, "nda"),
    ownFile,
  ];
  // Nothing changed yet in either drive since its feed's start.
  google.changes = Object.fromEntries(
    [sales.id, legal.id].map((id) => [
      `${id}-1`,
      { newStartPageToken: `${id}-1`, changes: [] },
    ])
  );
  google.contents = {
    "price-list": "Coffee 3.20",
    contract: "%PDF-1.7",
    nda: "secret",
    "own-notes": "my own notes",
  };
};

/** Whether a call asked for shared drives' items, as Drive requires to give them. */
const allDrives = (url: URL): boolean =>
  url.searchParams.get("supportsAllDrives") === "true";

/** A page of `items` from `pageToken`, `pageSize` at a time. */
const paged = <Item>(url: URL, items: readonly Item[], fallback: number) => {
  const size = Number(url.searchParams.get("pageSize") ?? fallback);
  const from = Number(url.searchParams.get("pageToken") ?? 0);
  return {
    page: items.slice(from, from + size),
    next: from + size < items.length ? String(from + size) : undefined,
  };
};

/** files.list, as Drive answers it for the corpus asked for. */
const listing = (url: URL): Response => {
  const corpora = url.searchParams.get("corpora") ?? "user";
  const driveId = url.searchParams.get("driveId");
  if (corpora === "drive") {
    // "The `driveId` must be specified in the request."
    if (
      driveId === null ||
      !allDrives(url) ||
      url.searchParams.get("includeItemsFromAllDrives") !== "true"
    ) {
      return badRequest("A shared drive's listing needs its driveId");
    }
    if (!google.drives.some(({ id }) => id === driveId)) {
      return notFound();
    }
  }
  const files = google.files.filter((file) =>
    corpora === "drive" ? file.driveId === driveId : file.ownedByMe === true
  );
  const { page, next } = paged(url, files, 100);
  return Response.json({
    files: page,
    ...(next === undefined ? {} : { nextPageToken: next }),
  });
};

/** Why `url` asks for a query option its method's page doesn't list, if it does. */
const undocumented = (url: URL): Response | undefined => {
  const method = documented.find((each) => each.path.test(url.pathname));
  if (method === undefined) {
    return notFound();
  }
  const unknown = [...url.searchParams.keys()].filter(
    (name) => !method.options.includes(name) && !standard.has(name)
  );
  return unknown.length > 0
    ? badRequest(`Unknown options: ${unknown.join(", ")}`)
    : undefined;
};

/** drives.list and drives.get. */
const drivesCall = (url: URL): Response => {
  const path = url.pathname;
  if (path === "/drive/v3/drives") {
    const { page, next } = paged(url, google.drives, 10);
    return Response.json({
      drives: page,
      ...(next === undefined ? {} : { nextPageToken: next }),
    });
  }
  const id = decodeURIComponent(path.slice("/drive/v3/drives/".length));
  return google.drives.some((drive) => drive.id === id)
    ? Response.json({ id })
    : notFound();
};

/** changes.getStartPageToken and changes.list. */
const changesCall = (url: URL): Response => {
  if (url.pathname === "/drive/v3/changes/startPageToken") {
    const driveId = url.searchParams.get("driveId");
    if (driveId !== null && !allDrives(url)) {
      return badRequest("A shared drive's changes need supportsAllDrives");
    }
    return Response.json({ startPageToken: `${driveId ?? "own"}-1` });
  }
  const page = google.changes[url.searchParams.get("pageToken") ?? ""];
  return page === undefined ? notFound() : Response.json(page);
};

/** files.get, its bytes, and files.export. */
const fileCall = (url: URL): Response => {
  const [id = "", exported] = url.pathname
    .slice("/drive/v3/files/".length)
    .split("/");
  const file = google.files.find((each) => each.id === id);
  const content = google.contents[id];
  // A shared drive's file is there only for a call that supports them.
  if (
    file === undefined ||
    content === undefined ||
    (file.driveId !== undefined && exported === undefined && !allDrives(url))
  ) {
    return notFound();
  }
  if (exported === "export" || url.searchParams.get("alt") === "media") {
    return new Response(content);
  }
  return Response.json({ version: file.version });
};

const internet = fakeInternet((request, url) => {
  const refused = scopeRefusal(providers, request, url);
  if (refused !== undefined) {
    return refused;
  }
  if (url.hostname !== apisHost) {
    return notFound();
  }
  const wrong = undocumented(url);
  if (wrong !== undefined) {
    return wrong;
  }
  const path = url.pathname;
  if (path.startsWith("/drive/v3/drives")) {
    return drivesCall(url);
  }
  if (path.startsWith("/drive/v3/changes")) {
    return changesCall(url);
  }
  return path === "/drive/v3/files" ? listing(url) : fileCall(url);
});

/** What reached Google, as paths with their query. */
const sentToGoogle = () =>
  internet.sent
    .filter(({ host }) => host === apisHost)
    .map(({ path }) => new URL(`https://${apisHost}${path}`));

/** A Google account an admin connected for the company, with what the sync holds. */
const sharedConnection = async () => {
  reset();
  const admin = someone("admin");
  const connectionId = await connectAccount(
    providers,
    admin,
    { ...mailboxAccount("google"), granted: syncGrant },
    { provider: "google", scope: "shared" }
  );
  return { admin, connectionId };
};

const feed = "shared-drives";

const pick = async (
  admin: ReturnType<typeof someone>,
  connectionId: string,
  places: string[]
) =>
  await exports.default.pickSyncPlaces({
    person: admin,
    connectionId,
    feed,
    places,
  });

const read = async (
  connectionId: string,
  place: string,
  cursor: string | null
) => await exports.default.readSyncPage({ connectionId, feed, place, cursor });

/** The code a call was refused with, or "ok". */
const outcomeOf = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    await call();
    return "ok";
  } catch (error) {
    return (
      syncErrors.codeOf(error) ??
      roleErrors.codeOf(error) ??
      connectionErrors.codeOf(error) ??
      String(error)
    );
  }
};

/** Reads `place` from `from` (the start: null) until nothing more is due at once. */
const readAll = async (
  connectionId: string,
  place: string,
  from: string | null = null
) => {
  const pages = [];
  let cursor = from;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const page = await read(connectionId, place, cursor);
    pages.push(page);
    ({ cursor } = page);
    if (!page.more) {
      return { items: pages.flatMap(({ items }) => items), cursor };
    }
  }
};

describe("syncing a shared connection's picked shared drives", () => {
  it("shows an admin the shared drives the account is in, and lists only those picked", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, [sales.id]);

    expect({
      choices: await exports.default.syncPlaceChoices({
        person: admin,
        connectionId,
        feed,
        cursor: null,
      }),
      places: await exports.default.listSyncPlaces({
        connectionId,
        feed,
        cursor: null,
      }),
    }).toStrictEqual({
      choices: {
        choices: [
          { place: sales.id, title: "Sales", picked: true },
          { place: legal.id, title: "Legal", picked: false },
        ],
        cursor: null,
      },
      places: { places: [sales.id], cursor: null },
    });
  });

  it("goes on through Google's pages of shared drives", async () => {
    const { admin, connectionId } = await sharedConnection();
    google.drives = Array.from({ length: 150 }, (_, index) => ({
      id: `drive-${index}`,
      name: `Drive ${index}`,
    }));
    await pick(admin, connectionId, ["drive-149"]);
    const places = await exports.default.listSyncPlaces({
      connectionId,
      feed,
      cursor: null,
    });
    expect(places).toStrictEqual({ places: ["drive-149"], cursor: null });
  });

  it("reads a picked drive whole, then its changes, with no reader copied from Google", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, [sales.id]);

    const first = await read(connectionId, sales.id, null);
    expect(first.items).toStrictEqual([
      {
        gone: false,
        id: "price-list",
        kind: "file",
        version: "3",
        changedAt: "2026-11-10T09:00:00.000Z",
        title: "price-list.pdf",
        content: {
          type: "file",
          contentType: pdf,
          base64: btoa("Coffee 3.20"),
        },
        // The connection's Brain audience reads it, chosen in Grasp.
        readers: null,
        changedBy: "owner@acme.test",
        partOf: null,
      },
      expect.objectContaining({ id: "contract", readers: null }),
    ]);

    // Edited at Google: the file is at version 4 now. And a brief that
    // moved into Legal, which the account can read there.
    google.files = [
      ...google.files.map((file) =>
        file.id === "price-list" ? { ...file, version: "4" } : file
      ),
      fileIn(legal.id, "brief"),
    ];
    google.contents.brief = "brief";
    google.changes = {
      ...google.changes,
      [`${sales.id}-1`]: {
        newStartPageToken: `${sales.id}-2`,
        changes: [
          {
            fileId: "price-list",
            time: "2026-11-17T10:00:00.000Z",
            file: fileIn(sales.id, "price-list", { version: "4" }),
          },
          // Deleted, or out of the account's reach.
          {
            fileId: "contract",
            removed: true,
            time: "2026-11-17T10:01:00.000Z",
          },
          // In the bin.
          {
            fileId: "memo",
            time: "2026-11-17T10:02:00.000Z",
            file: fileIn(sales.id, "memo", { trashed: true }),
          },
          // Moved to another shared drive: no longer this place's.
          {
            fileId: "brief",
            time: "2026-11-17T10:03:00.000Z",
            file: fileIn(legal.id, "brief"),
          },
        ],
      },
    };
    const changes = await readAll(connectionId, sales.id, first.cursor);
    expect(changes.items).toStrictEqual([
      expect.objectContaining({ id: "price-list", version: "4", gone: false }),
      { gone: true, id: "contract", kind: "file" },
      { gone: true, id: "memo", kind: "file" },
      { gone: true, id: "brief", kind: "file" },
    ]);
  });

  it("never reads the connected account's own Drive, nor a drive nobody picked", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, [sales.id]);
    await readAll(connectionId, sales.id);
    const unpicked = await outcomeOf(
      async () => await read(connectionId, legal.id, null)
    );
    const own = await outcomeOf(
      async () =>
        await exports.default.readSyncPage({
          connectionId,
          feed: "drive",
          place: "own",
          cursor: null,
        })
    );

    const sent = sentToGoogle();
    expect({
      unpicked,
      own,
      // Every call named the picked drive, or a file of it, or the drive
      // listing; nothing read the account's own files or another drive.
      outsideThePick: sent.filter(
        (url) =>
          url.searchParams.get("driveId") !== sales.id &&
          !url.pathname.startsWith("/drive/v3/files/") &&
          url.pathname !== `/drive/v3/drives/${sales.id}`
      ),
      files: sent
        .filter(({ pathname }) => pathname.startsWith("/drive/v3/files/"))
        .map(({ pathname }) => pathname.split("/")[4]),
    }).toStrictEqual({
      unpicked: "sync.place_refused",
      own: "sync.place_refused",
      outsideThePick: [],
      files: ["price-list", "price-list", "contract", "contract"],
    });
  });

  it("fails a drive the account no longer sees before asking for any of its files, and stops listing it", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, [sales.id, legal.id]);
    google.drives = [legal];
    const before = sentToGoogle().length;

    const outcome = await outcomeOf(
      async () => await read(connectionId, sales.id, null)
    );
    const asked = sentToGoogle()
      .slice(before)
      .map(({ pathname }) => pathname);
    const places = await exports.default.listSyncPlaces({
      connectionId,
      feed,
      cursor: null,
    });

    expect({ outcome, asked, places }).toStrictEqual({
      outcome: "sync.provider_failed",
      asked: [`/drive/v3/drives/${sales.id}`],
      places: { places: [legal.id], cursor: null },
    });
  });
});
