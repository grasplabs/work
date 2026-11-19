import { connectionErrors } from "@grasp-os/shared/connect";
import { roleErrors } from "@grasp-os/shared/roles";
import { syncErrors } from "@grasp-os/shared/sync";
import type { SyncPage } from "@grasp-os/shared/sync";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  connectAccount,
  heldPicks,
  mailboxAccount,
  someone,
} from "./connect.ts";
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
// deleted kept; a drive the account no longer sees read at all; a file's
// readers taken from part of its permissions, or from a list the account
// can't see whole because it can't share the file (GRA-2145).

const providers = fakeProviders();

const apisHost = "www.googleapis.com";
const pdf = "application/pdf";
const folderType = "application/vnd.google-apps.folder";

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
  // https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/list
  {
    path: /^\/drive\/v3\/files\/[^/]+\/permissions$/u,
    options: [
      "pageSize",
      "pageToken",
      "supportsAllDrives",
      "supportsTeamDrives",
      "useDomainAdminAccess",
      "includePermissionsForView",
    ],
  },
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
  drives: {
    id: string;
    name: string;
    capabilities?: { canShare: boolean };
  }[];
  /** Every file, in listing order: shared drives' (`driveId`) and the account's own. */
  files: DriveFile[];
  /** Each shared drive's change feed, by page token. */
  changes: Record<string, Record<string, unknown>>;
  /** Each file's content, by ID. */
  contents: Record<string, string>;
  /**
   * Each file's permissions as `permissions.list` gives them, by ID: the
   * drive's members (inherited) and those shared on the file or its
   * folders. None: the list is refused (403).
   */
  permissions: Record<string, Record<string, unknown>[]>;
  /**
   * Pages of a file's permissions Google refuses, by file ID: the page
   * (its token; "" the first) and the status and reason it answers.
   */
  refusals: Record<string, { page: string; status: number; reason: string }>;
}

const google: Google = {
  drives: [],
  files: [],
  changes: {},
  contents: {},
  permissions: {},
  refusals: {},
};

// The account can share files in Sales, but only read in Legal.
const sales = {
  id: "drive-sales",
  name: "Sales",
  capabilities: { canShare: true },
};
const legal = {
  id: "drive-legal",
  name: "Legal",
  capabilities: { canShare: false },
};

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
  // At the drive's top, unless a test files it in a folder.
  parents: [driveId],
  lastModifyingUser: { emailAddress: "Owner@Acme.test" },
  // The connected account may share it: a manager, content manager or
  // contributor of the drive.
  capabilities: { canShare: true },
  ...fields,
});

/** A folder of a shared drive, in `parent`, with its access limited or not. */
const folderIn = (
  driveId: string,
  id: string,
  parent: string,
  limited: boolean
): DriveFile => ({
  id,
  name: id,
  mimeType: folderType,
  modifiedTime: "2026-11-10T09:00:00.000Z",
  version: "1",
  driveId,
  parents: [parent],
  inheritedPermissionsDisabled: limited,
});

/** A user granted access on the folder `folder`, as its files list them. */
const grantedOn = (
  emailAddress: string,
  folder: string
): Record<string, unknown> => ({
  type: "user",
  emailAddress,
  role: "reader",
  permissionDetails: [
    {
      permissionType: "file",
      inherited: true,
      inheritedFrom: folder,
      role: "reader",
    },
  ],
});

/** A member of a shared drive, as a file of it lists them: inherited. */
const member = (
  type: "user" | "group",
  emailAddress: string,
  driveId: string
): Record<string, unknown> => ({
  type,
  emailAddress,
  role: "writer",
  permissionDetails: [
    {
      permissionType: "member",
      inheritedFrom: driveId,
      inherited: true,
      role: "writer",
    },
  ],
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
  google.refusals = {};
  google.permissions = {
    "price-list": [
      member("user", "Ada@Acme.test", sales.id),
      member("group", "sales@acme.test", sales.id),
      // Shared on the file alone, with someone outside the drive.
      { type: "user", emailAddress: "buyer@partner.test", role: "reader" },
      // A link for the company: nobody's.
      {
        type: "domain",
        domain: "acme.test",
        allowFileDiscovery: false,
        role: "reader",
      },
    ],
    contract: [member("user", "ada@acme.test", sales.id)],
    nda: [member("user", "lee@acme.test", legal.id)],
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

/** permissions.list of the file `id`, 100 a page at most for a shared drive's. */
const permissionsCall = (url: URL, id: string): Response => {
  const file = google.files.find((each) => each.id === id);
  if (file === undefined || (file.driveId !== undefined && !allDrives(url))) {
    return notFound();
  }
  const refusal = google.refusals[id];
  if (
    refusal !== undefined &&
    refusal.page === (url.searchParams.get("pageToken") ?? "")
  ) {
    return Response.json(
      {
        error: {
          code: refusal.status,
          message: refusal.reason,
          errors: [{ reason: refusal.reason }],
        },
      },
      { status: refusal.status }
    );
  }
  const permissions = google.permissions[id];
  if (permissions === undefined) {
    return Response.json(
      {
        error: {
          code: 403,
          message:
            "The user does not have sufficient permissions for this file.",
          errors: [{ reason: "insufficientFilePermissions" }],
        },
      },
      { status: 403 }
    );
  }
  const { page, next } = paged(url, permissions, 100);
  return Response.json({
    permissions: page,
    ...(next === undefined ? {} : { nextPageToken: next }),
  });
};

/** files.get, its bytes, files.export and permissions.list. */
const fileCall = (url: URL): Response => {
  const [id = "", exported] = url.pathname
    .slice("/drive/v3/files/".length)
    .split("/");
  if (exported === "permissions") {
    return permissionsCall(url, id);
  }
  const file = google.files.find((each) => each.id === id);
  // A folder's own fields: where it is, and whether its access is limited
  // ("inheritedPermissionsDisabled… Whether this file has inherited
  // permissions disabled"), which only a folder carries.
  if (file?.mimeType === folderType && exported === undefined) {
    return allDrives(url)
      ? Response.json({
          id: file.id,
          parents: file.parents,
          inheritedPermissionsDisabled: file.inheritedPermissionsDisabled,
        })
      : notFound();
  }
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
    from: await heldPicks(connectionId, feed),
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

/** The readers of each file a whole read of `place` gives, in order. */
const readersOf = async (connectionId: string, place: string) => {
  const { items } = await readAll(connectionId, place);
  return items.flatMap((item) => (item.gone ? [] : [item.readers]));
};

describe("syncing a shared connection's picked shared drives", () => {
  it("shows an admin the shared drives the account is in, whether it can share in each, and lists only those picked", async () => {
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
        feed: "shared-drives",
        choices: [
          {
            place: sales.id,
            title: "Sales",
            within: null,
            sharingRead: true,
            picked: true,
          },
          {
            place: legal.id,
            title: "Legal",
            within: null,
            sharingRead: false,
            picked: false,
          },
        ],
        picks: [sales.id],
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

  it("reads a picked drive whole, then its changes, each file read by those Google lets open it", async () => {
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
        // The drive's members, and whom the file was shared with; the
        // company's link is nobody's.
        readers: [
          { kind: "account", id: "ada@acme.test" },
          { kind: "group", id: "sales@acme.test" },
          { kind: "account", id: "buyer@partner.test" },
          { kind: "link" },
        ],
        changedBy: "owner@acme.test",
        partOf: null,
      },
      expect.objectContaining({
        id: "contract",
        readers: [{ kind: "account", id: "ada@acme.test" }],
      }),
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
    // Nothing it doesn't use: no permissions asked of Drive in the
    // listing or the change feed, where a shared drive's files carry none.
    const asked = sentToGoogle().filter(({ pathname }) =>
      ["/drive/v3/files", "/drive/v3/changes"].includes(pathname)
    );
    expect({
      calls: asked.length > 0,
      permissions: asked.filter((url) =>
        (url.searchParams.get("fields") ?? "").includes("permissions")
      ),
    }).toStrictEqual({ calls: true, permissions: [] });
  });

  it("reads a file's permissions page by page, the drive's members included, and gives nobody's for a file the account can't share", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, [sales.id]);
    google.files = [
      fileIn(sales.id, "price-list"),
      // Only readable by the account: Google would list it no one else.
      fileIn(sales.id, "board-minutes", { capabilities: { canShare: false } }),
      // Google said nothing of whether the account can share it.
      fileIn(sales.id, "untold", { capabilities: undefined }),
    ];
    google.contents["board-minutes"] = "minutes";
    google.contents.untold = "untold";
    // The drive's 150 members: two pages of Google's.
    google.permissions["price-list"] = Array.from({ length: 150 }, (_, index) =>
      member("user", `person-${index}@acme.test`, sales.id)
    );
    google.permissions["board-minutes"] = [
      member("user", "ada@acme.test", sales.id),
    ];
    google.permissions.untold = [member("user", "ada@acme.test", sales.id)];
    const before = sentToGoogle().length;

    const { items } = await readAll(connectionId, sales.id);
    const asked = sentToGoogle()
      .slice(before)
      .filter(({ pathname }) => pathname.endsWith("/permissions"))
      .map((url) => ({
        file: url.pathname.split("/")[4],
        page: url.searchParams.get("pageToken"),
        allDrives: allDrives(url),
      }));

    expect({
      readers: items.map((item) =>
        item.gone
          ? undefined
          : {
              id: item.id,
              count: item.readers?.length,
              last: item.readers?.at(-1),
            }
      ),
      asked,
    }).toStrictEqual({
      readers: [
        {
          id: "price-list",
          count: 150,
          last: { kind: "account", id: "person-149@acme.test" },
        },
        { id: "board-minutes", count: undefined, last: undefined },
        { id: "untold", count: undefined, last: undefined },
      ],
      asked: [
        { file: "price-list", page: null, allDrives: true },
        { file: "price-list", page: "100", allDrives: true },
      ],
    });
  });

  it("never gives a file part of its readers: a list refused, or longer than a read has room for, is nobody's", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, [sales.id]);
    google.files = [fileIn(sales.id, "crowded"), fileIn(sales.id, "refused")];
    google.contents.crowded = "crowded";
    google.contents.refused = "refused";
    // More pages of permissions than one read may send requests.
    google.permissions.crowded = Array.from({ length: 6000 }, (_, index) =>
      member("user", `person-${index}@acme.test`, sales.id)
    );
    // The list refused to the account.
    delete google.permissions.refused;

    const { items } = await readAll(connectionId, sales.id);

    expect(
      items.map((item) =>
        item.gone
          ? undefined
          : {
              id: item.id,
              readers: item.readers,
              content: item.content !== null,
            }
      )
    ).toStrictEqual([
      // Late on two reads in a row: passed over, with neither.
      { id: "crowded", readers: null, content: false },
      { id: "refused", readers: null, content: true },
    ]);
  });

  it("gives a file under a folder with limited access only to an organizer and those granted on the file or that folder, never the drive's members", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, [sales.id]);
    // Contracts, legal only: a folder with limited access in Sales.
    google.files = [
      folderIn(sales.id, "contracts", sales.id, true),
      fileIn(sales.id, "msa", { parents: ["contracts"] }),
    ];
    google.contents.msa = "msa";
    google.permissions.msa = [
      // Members of the drive, as Google lists them on any of its files.
      member("user", "seller@acme.test", sales.id),
      member("group", "sales@acme.test", sales.id),
      { ...member("user", "manager@acme.test", sales.id), role: "organizer" },
      // Granted on the folder itself.
      grantedOn("legal@acme.test", "contracts"),
      // Granted on the file itself.
      {
        type: "user",
        emailAddress: "auditor@acme.test",
        role: "reader",
        permissionDetails: [
          { permissionType: "file", inherited: false, role: "reader" },
        ],
      },
    ];

    await expect(readersOf(connectionId, sales.id)).resolves.toStrictEqual([
      [
        { kind: "account", id: "manager@acme.test" },
        { kind: "account", id: "legal@acme.test" },
        { kind: "account", id: "auditor@acme.test" },
      ],
    ]);
  });

  it("counts what a folder below a limited one grants, and nothing from above the nearest limited folder", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, [sales.id]);
    google.files = [
      folderIn(sales.id, "contracts", sales.id, true),
      // An ordinary folder in it, and another limited one.
      folderIn(sales.id, "signed", "contracts", false),
      folderIn(sales.id, "board", "contracts", true),
      fileIn(sales.id, "nda", { parents: ["signed"] }),
      fileIn(sales.id, "minutes", { parents: ["board"] }),
    ];
    google.contents.nda = "nda";
    google.contents.minutes = "minutes";
    const grants = [
      member("user", "seller@acme.test", sales.id),
      grantedOn("legal@acme.test", "contracts"),
      grantedOn("signer@acme.test", "signed"),
      grantedOn("director@acme.test", "board"),
    ];
    google.permissions.nda = grants;
    google.permissions.minutes = grants;

    await expect(readersOf(connectionId, sales.id)).resolves.toStrictEqual([
      [
        { kind: "account", id: "legal@acme.test" },
        { kind: "account", id: "signer@acme.test" },
      ],
      [{ kind: "account", id: "director@acme.test" }],
    ]);
  });

  it("gives nobody a file whose folders can't all be read, and reads each folder once a read", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, [sales.id]);
    google.files = [
      folderIn(sales.id, "projects", sales.id, false),
      // A folder Drive no longer gives.
      fileIn(sales.id, "lost", { parents: ["gone-folder"] }),
      ...Array.from({ length: 5 }, (_, index) =>
        fileIn(sales.id, `plan-${index}`, { parents: ["projects"] })
      ),
    ];
    google.contents.lost = "lost";
    google.permissions.lost = [member("user", "seller@acme.test", sales.id)];
    for (let index = 0; index < 5; index += 1) {
      google.contents[`plan-${index}`] = "plan";
      google.permissions[`plan-${index}`] = [
        member("user", "seller@acme.test", sales.id),
      ];
    }
    const before = sentToGoogle().length;

    const readers = await readersOf(connectionId, sales.id);
    const fetched = sentToGoogle()
      .slice(before)
      .filter(({ pathname }) => pathname === "/drive/v3/files/projects");

    expect({ readers, fetched: fetched.length }).toStrictEqual({
      readers: [
        null,
        ...Array.from({ length: 5 }, () => [
          { kind: "account", id: "seller@acme.test" },
        ]),
      ],
      fetched: 1,
    });
  });

  it("gives nobody a file whose permissions Google refuses part of the way", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, [sales.id]);
    google.files = [fileIn(sales.id, "price-list")];
    google.permissions["price-list"] = Array.from({ length: 150 }, (_, index) =>
      member("user", `person-${index}@acme.test`, sales.id)
    );
    // The second page's token refused: start again from the first page.
    google.refusals["price-list"] = {
      page: "100",
      status: 400,
      reason: "invalid",
    };

    const { items } = await readAll(connectionId, sales.id);

    expect(
      items.map((item) => (item.gone ? null : item.readers))
    ).toStrictEqual([null]);
  });

  it("waits when Google throttles a file's permissions, rather than giving it nobody", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, [sales.id]);
    google.files = [fileIn(sales.id, "price-list")];
    google.refusals["price-list"] = {
      page: "",
      status: 403,
      reason: "rateLimitExceeded",
    };

    await expect(
      outcomeOf(async () => await read(connectionId, sales.id, null))
    ).resolves.toBe("sync.throttled");
  });

  it("moves on past a file whose folders and permissions take every request a read has left, and one more or one fewer", async () => {
    // A read's room (50 requests): the drive, the change feed's start and
    // the listing leave 47, for the file's folders and its one page of
    // permissions.
    const outcomes = [];
    for (const depth of [45, 46, 47]) {
      // oxlint-disable-next-line no-await-in-loop -- one drive after another
      const { admin, connectionId } = await sharedConnection();
      // oxlint-disable-next-line no-await-in-loop -- one drive after another
      await pick(admin, connectionId, [sales.id]);
      const chain = Array.from(
        { length: depth },
        (_, index) => `deep-${index}`
      );
      google.files = [
        ...chain.map((id, index) =>
          folderIn(sales.id, id, chain[index + 1] ?? sales.id, false)
        ),
        fileIn(sales.id, "deep", { parents: [chain[0] ?? sales.id] }),
      ];
      google.contents.deep = "deep";
      google.permissions.deep = [member("user", "seller@acme.test", sales.id)];
      const pages: (number | string)[] = [];
      let cursor: string | null = null;
      for (let at = 0; at < 4; at += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one read after another
        const page: SyncPage | string = await read(
          connectionId,
          sales.id,
          cursor
        ).catch((error: unknown) => syncErrors.codeOf(error) ?? "failed");
        pages.push(typeof page === "string" ? page : page.items.length);
        if (typeof page === "string") {
          break;
        }
        ({ cursor } = page);
        if (page.items.length > 0) {
          break;
        }
      }
      // The file reached, and no read failed on the way. (This fake lists
      // the drive's folders too, as entries with nothing in them.)
      outcomes.push({
        depth,
        reached: pages.at(-1) === 1,
        failed: pages.filter((page) => typeof page === "string"),
      });
    }

    expect(outcomes).toStrictEqual([
      { depth: 45, reached: true, failed: [] },
      { depth: 46, reached: true, failed: [] },
      { depth: 47, reached: true, failed: [] },
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
      // Each file's permissions, bytes and version.
      files: [
        "price-list",
        "price-list",
        "price-list",
        "contract",
        "contract",
        "contract",
      ],
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
