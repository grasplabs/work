import { syncErrors } from "@grasp-os/shared/sync";
import type { SyncPage } from "@grasp-os/shared/sync";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { connectAccount, mailboxAccount, someone } from "./connect.ts";
import { fakeInternet } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";

// The Microsoft 365 connector's sync of a shared connection's picked
// SharePoint document libraries (library-sync.ts), through connect's real
// read (src/sync.ts): a fresh isolate, the egress that adds the token and
// follows a download's redirect without it, and Graph mocked at its host.
// The mocked Graph follows the reference pages: each call answers only the
// query options its page lists, and a `$select` only of the resource's
// properties. The ways it can fail come first: a library nobody picked
// read; a pick that names someone's OneDrive read; the connected
// account's own OneDrive or mail read through a shared connection; a
// deleted file or a shortcut kept; the library's own permissions taken as
// the readers; a personal site offered as a place.

const providers = fakeProviders();

const graphHost = "graph.microsoft.com";
const storageHost = "acme.sharepoint.com";

/** The query options each call's reference page lists, by path pattern. */
const documented: readonly { path: RegExp; options: readonly string[] }[] = [
  // https://learn.microsoft.com/en-us/graph/api/site-search?view=graph-rest-1.0
  // (and the `$skiptoken` of Graph's own next link).
  { path: /^\/v1\.0\/sites$/u, options: ["search", "$skiptoken"] },
  // https://learn.microsoft.com/en-us/graph/api/drive-list?view=graph-rest-1.0
  {
    path: /^\/v1\.0\/sites\/[^/]+\/drives$/u,
    options: ["$expand", "$select", "$skiptoken", "$top", "$orderby"],
  },
  // https://learn.microsoft.com/en-us/graph/api/drive-get?view=graph-rest-1.0
  { path: /^\/v1\.0\/drives\/[^/]+$/u, options: ["$select"] },
  // https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0
  {
    path: /^\/v1\.0\/drives\/[^/]+\/root\/delta$/u,
    options: ["token", "$select", "$expand", "$top"],
  },
  // https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0
  { path: /^\/v1\.0\/drives\/[^/]+\/items\/[^/]+\/content$/u, options: [] },
];

/** The drive resource's properties, for a `$select` of a drive. */
const driveProperties = new Set([
  "createdBy",
  "createdDateTime",
  "description",
  "driveType",
  "id",
  "lastModifiedBy",
  "lastModifiedDateTime",
  "name",
  "owner",
  "quota",
  "sharepointIds",
  "system",
  "webUrl",
]);

/** The driveItem resource's properties, for a `$select` of an item. */
const driveItemProperties = new Set([
  "audio",
  "bundle",
  "content",
  "createdBy",
  "createdDateTime",
  "cTag",
  "deleted",
  "description",
  "eTag",
  "file",
  "fileSystemInfo",
  "folder",
  "id",
  "image",
  "lastModifiedBy",
  "lastModifiedDateTime",
  "location",
  "malware",
  "name",
  "package",
  "parentReference",
  "pendingOperations",
  "photo",
  "publication",
  "remoteItem",
  "root",
  "searchResult",
  "shared",
  "sharepointIds",
  "size",
  "specialFolder",
  "video",
  "webDavUrl",
  "webUrl",
]);

const invalid = (): Response =>
  Response.json({ error: { code: "invalidRequest" } }, { status: 400 });

const itemNotFound = (): Response =>
  Response.json({ error: { code: "itemNotFound" } }, { status: 404 });

type Entry = Record<string, unknown> & { id: string };

interface Library {
  id: string;
  name: string;
  driveType: string;
}

/** What SharePoint holds, for each test to set. */
interface SharePoint {
  /** The sites a search finds, a page at a time. */
  sitePages: { id: string; displayName: string }[][];
  /** Each site's drives. */
  drives: Record<string, Library[]>;
  /** Each drive's delta feed: each token's entries, and the token after them. */
  feeds: Record<string, Record<string, { entries: Entry[]; end: string }>>;
  /** Each file's bytes, by ID. */
  contents: Record<string, string>;
}

const salesSite = "acme.sharepoint.com,1111,2222";
const legalSite = "acme.sharepoint.com,3333,4444";
const personalSite = "acme-my.sharepoint.com,5555,6666";

const salesDocs: Library = {
  id: "b!sales-docs",
  name: "Documents",
  driveType: "documentLibrary",
};
const salesContracts: Library = {
  id: "b!sales-contracts",
  name: "Contracts",
  driveType: "documentLibrary",
};
const legalDocs: Library = {
  id: "b!legal-docs",
  name: "Documents",
  driveType: "documentLibrary",
};
/** The connected account's own OneDrive, on its personal site. */
const ownOneDrive: Library = {
  id: "b!own-onedrive",
  name: "OneDrive",
  driveType: "business",
};

const sharePoint: SharePoint = {
  sitePages: [],
  drives: {},
  feeds: {},
  contents: {},
};

/** Graph's clock, as its `Date` header gives it. */
const graphDate = "Tue, 17 Nov 2026 10:00:00 GMT";
/** When a listing began, by Graph's clock, as a timestamp token. */
const listedAt = "2026-11-17T10:00:00Z";

/** A file in `library`. */
const fileIn = (
  library: Library,
  id: string,
  fields: Record<string, unknown> = {}
): Entry => ({
  id,
  name: `${id}.pdf`,
  eTag: `"{${id}},1"`,
  lastModifiedDateTime: "2026-11-10T09:00:00Z",
  size: 8,
  file: { mimeType: "application/pdf" },
  parentReference: { driveId: library.id },
  lastModifiedBy: { user: { id: "5D33DD65-0000-4000-8000-000000000001" } },
  ...fields,
});

const reset = (): void => {
  sharePoint.sitePages = [
    [
      { id: salesSite, displayName: "Sales" },
      { id: personalSite, displayName: "Owner's OneDrive" },
    ],
    [{ id: legalSite, displayName: "Legal" }],
  ];
  sharePoint.drives = {
    [salesSite]: [salesDocs, salesContracts],
    [legalSite]: [legalDocs],
    [personalSite]: [ownOneDrive],
  };
  sharePoint.feeds = Object.fromEntries(
    [salesDocs, salesContracts, legalDocs, ownOneDrive].map((library) => [
      library.id,
      {
        "": {
          entries: [
            { id: `${library.id}-root`, name: "root", root: {}, folder: {} },
            fileIn(library, `${library.id}-file`),
          ],
          end: "t1",
        },
        [listedAt]: { entries: [], end: "t1" },
        t1: { entries: [], end: "t1" },
      },
    ])
  );
  sharePoint.contents = Object.fromEntries(
    [salesDocs, salesContracts, legalDocs, ownOneDrive].map(({ id }) => [
      `${id}-file`,
      `bytes of ${id}`,
    ])
  );
};

const selectsOnly = (url: URL, properties: ReadonlySet<string>): boolean =>
  (url.searchParams.get("$select") ?? "")
    .split(",")
    .every((name) => name === "" || properties.has(name));

/** A library's drive, by ID, wherever it is. */
const libraryOf = (id: string): Library | undefined =>
  Object.values(sharePoint.drives)
    .flat()
    .find((library) => library.id === id);

const deltaPage = (driveId: string, url: URL): Response => {
  if (!selectsOnly(url, driveItemProperties)) {
    return invalid();
  }
  const at = sharePoint.feeds[driveId]?.[url.searchParams.get("token") ?? ""];
  if (at === undefined) {
    return Response.json(
      { error: { code: "resyncRequired" } },
      { status: 410 }
    );
  }
  const base = `https://${graphHost}/v1.0/drives/${driveId}/root`;
  return Response.json(
    {
      value: at.entries,
      "@odata.deltaLink": `${base}/delta?(token='${at.end}')`,
    },
    { headers: { date: graphDate } }
  );
};

/** Whether `url` asks only for query options its call's page lists. */
const isDocumented = (url: URL): boolean => {
  const call = documented.find((each) => each.path.test(url.pathname));
  if (call === undefined) {
    return false;
  }
  // OData's option names are case-insensitive (`$skipToken`, `$skiptoken`).
  const known = new Set(call.options.map((name) => name.toLowerCase()));
  return [...url.searchParams.keys()].every((name) =>
    known.has(name.toLowerCase())
  );
};

/** A page of the sites a search finds, with Graph's next link while more are left. */
const siteSearch = (url: URL): Response => {
  if (url.searchParams.get("search") === null) {
    return invalid();
  }
  const page = Number(url.searchParams.get("$skiptoken") ?? 0);
  const next = page + 1 < sharePoint.sitePages.length;
  return Response.json({
    value: sharePoint.sitePages[page] ?? [],
    ...(next
      ? {
          "@odata.nextLink": `https://${graphHost}/v1.0/sites?search=*&$skiptoken=${page + 1}`,
        }
      : {}),
  });
};

/** A drive's own calls: the drive, its delta, an item's content. */
const driveCall = (library: Library, rest: string, url: URL): Response => {
  if (rest === "") {
    return selectsOnly(url, driveProperties)
      ? Response.json({ id: library.id, driveType: library.driveType })
      : invalid();
  }
  if (rest === "/root/delta") {
    return deltaPage(library.id, url);
  }
  const item = /^\/items\/(?<item>[^/]+)\/content$/u.exec(rest)?.groups?.item;
  if (item !== undefined && sharePoint.contents[item] !== undefined) {
    // Graph redirects to the file on SharePoint, as it does.
    return Response.redirect(`https://${storageHost}/download/${item}`, 302);
  }
  return itemNotFound();
};

/** A site's drives, or a drive's own calls. */
const siteOrDriveCall = (url: URL): Response => {
  const [, kind = "", id = "", rest = ""] =
    /^\/v1\.0\/(?<kind>sites|drives)\/(?<id>[^/]+)(?<rest>\/.*)?$/u.exec(
      url.pathname
    ) ?? [];
  const decoded = decodeURIComponent(id);
  if (kind === "sites" && rest === "/drives") {
    const drives = sharePoint.drives[decoded];
    return drives === undefined || !selectsOnly(url, driveProperties)
      ? itemNotFound()
      : Response.json({ value: drives });
  }
  const library = libraryOf(decoded);
  return kind === "drives" && library !== undefined
    ? driveCall(library, rest, url)
    : itemNotFound();
};

const internet = fakeInternet((_request, url) => {
  if (url.hostname === storageHost) {
    const content =
      sharePoint.contents[url.pathname.slice("/download/".length)];
    return content === undefined ? itemNotFound() : new Response(content);
  }
  if (url.hostname !== graphHost) {
    return itemNotFound();
  }
  if (!isDocumented(url)) {
    return documented.some((each) => each.path.test(url.pathname))
      ? invalid()
      : itemNotFound();
  }
  return url.pathname === "/v1.0/sites"
    ? siteSearch(url)
    : siteOrDriveCall(url);
});

/** What reached Graph, by path. */
const sentToGraph = () =>
  internet.sent
    .filter(({ host }) => host === graphHost)
    .map(({ path }) => path.split("?")[0] ?? "");

/** A Microsoft account an admin connected for the company. */
const sharedConnection = async () => {
  reset();
  const admin = someone("admin");
  const connectionId = await connectAccount(
    providers,
    admin,
    mailboxAccount(),
    { scope: "shared" }
  );
  return { admin, connectionId };
};

const feed = "libraries";

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
): Promise<SyncPage> =>
  await exports.default.readSyncPage({ connectionId, feed, place, cursor });

/** The code a call was refused with, or "ok". */
const outcomeOf = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    await call();
    return "ok";
  } catch (error) {
    return syncErrors.codeOf(error) ?? String(error);
  }
};

/** Reads `place` from `from` (the start: null) until nothing more is due at once. */
const readAll = async (
  connectionId: string,
  place: string,
  from: string | null = null
) => {
  const pages: SyncPage[] = [];
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

describe("syncing a shared connection's picked SharePoint libraries", () => {
  it("shows an admin the document libraries of the sites the account finds, never a OneDrive", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, [salesContracts.id, legalDocs.id]);

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
          { place: salesDocs.id, title: "Sales › Documents", picked: false },
          {
            place: salesContracts.id,
            title: "Sales › Contracts",
            picked: true,
          },
          { place: legalDocs.id, title: "Legal › Documents", picked: true },
        ],
        cursor: null,
      },
      places: { places: [salesContracts.id, legalDocs.id], cursor: null },
    });
  });

  it("reads a picked library whole, catches up from when it began, then its changes, with no reader copied", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, [salesDocs.id]);
    const before = sentToGraph().length;

    const listing = await readAll(connectionId, salesDocs.id);
    expect(listing.items).toStrictEqual([
      {
        gone: false,
        id: `${salesDocs.id}-file`,
        kind: "file",
        version: `"{${salesDocs.id}-file},1"`,
        changedAt: "2026-11-10T09:00:00Z",
        title: `${salesDocs.id}-file.pdf`,
        content: {
          type: "file",
          contentType: "application/pdf",
          base64: btoa(`bytes of ${salesDocs.id}`),
        },
        // The connection's Brain audience reads it, chosen in Grasp.
        readers: null,
        changedBy: "5d33dd65-0000-4000-8000-000000000001",
        partOf: null,
      },
    ]);
    // The listing, then a catch-up from its start by Graph's own clock.
    expect(
      internet.sent
        .slice(before)
        .filter(({ path }) => path.includes("/root/delta"))
        .map(({ path }) =>
          new URL(`https://${graphHost}${path}`).searchParams.get("token")
        )
    ).toStrictEqual([null, listedAt]);

    sharePoint.feeds[salesDocs.id] = {
      ...sharePoint.feeds[salesDocs.id],
      t1: {
        entries: [
          fileIn(salesDocs, "plan", { eTag: '"{plan},2"' }),
          // Deleted.
          { id: `${salesDocs.id}-file`, deleted: { state: "deleted" } },
          // A shortcut to another drive's item.
          fileIn(salesDocs, "shortcut", { remoteItem: { id: "elsewhere" } }),
          // Of another drive.
          fileIn(legalDocs, "moved"),
        ],
        end: "t2",
      },
      t2: { entries: [], end: "t2" },
    };
    sharePoint.contents.plan = "the plan";
    const changes = await readAll(connectionId, salesDocs.id, listing.cursor);
    expect(changes.items).toStrictEqual([
      expect.objectContaining({
        id: "plan",
        version: '"{plan},2"',
        readers: null,
      }),
      { gone: true, id: `${salesDocs.id}-file`, kind: "file" },
      { gone: true, id: "shortcut", kind: "file" },
      { gone: true, id: "moved", kind: "file" },
    ]);
    // Nothing of the account's own, and no permissions read.
    expect(
      sentToGraph().filter(
        (path) => path.startsWith("/v1.0/me") || path.endsWith("/permissions")
      )
    ).toStrictEqual([]);
  });

  it("never reads a library nobody picked, nor a pick that names someone's OneDrive", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, [salesDocs.id, ownOneDrive.id]);
    const before = sentToGraph().length;

    const outcomes = {
      unpicked: await outcomeOf(
        async () => await read(connectionId, legalDocs.id, null)
      ),
      oneDrive: await outcomeOf(
        async () => await read(connectionId, ownOneDrive.id, null)
      ),
      ownDrive: await outcomeOf(
        async () =>
          await exports.default.readSyncPage({
            connectionId,
            feed: "drive",
            place: "own",
            cursor: null,
          })
      ),
    };
    const places = await exports.default.listSyncPlaces({
      connectionId,
      feed,
      cursor: null,
    });

    expect({
      outcomes,
      asked: sentToGraph()
        .slice(before)
        .filter((path) => path !== "/v1.0/sites" && !path.endsWith("/drives")),
      places,
    }).toStrictEqual({
      outcomes: {
        unpicked: "sync.place_refused",
        // Read as a drive, found no library, and refused before its files.
        oneDrive: "sync.provider_failed",
        ownDrive: "sync.place_refused",
      },
      asked: [`/v1.0/drives/${encodeURIComponent(ownOneDrive.id)}`],
      // A OneDrive is never among the places, picked or not.
      places: { places: [salesDocs.id], cursor: null },
    });
  });
});
