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
import { fakeInternet } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";
import { acmeTenant } from "./provider-config.ts";

// The Microsoft 365 connector's sync of a shared connection's picked
// SharePoint document libraries (library-sync.ts), through connect's real
// read (src/sync.ts): a fresh isolate, the egress that adds the token and
// follows a download's redirect without it, and Graph mocked at its host.
// The mocked Graph follows the reference pages: each call answers only the
// query options its page lists, and a `$select` only of the resource's
// properties. The ways it can fail come first: a library nobody picked
// read; a pick that names someone's OneDrive read; the connected
// account's own OneDrive or mail read through a shared connection; a
// deleted file or a shortcut kept; a personal site offered as a place.
// Who may open a file is read from SharePoint's REST API on the company's
// host (GRA-2145), mocked at that host too: an account that isn't the
// site's owner, a group whose members are hidden, a list read in part, a
// grant that doesn't reach SharePoint, and either token sent to the
// other's host each give nobody, or never happen.

const providers = fakeProviders();

const graphHost = "graph.microsoft.com";
const storageHost = "acme.sharepoint.com";

/** The query options each call's reference page lists, by path pattern. */
const documented: readonly { path: RegExp; options: readonly string[] }[] = [
  // https://learn.microsoft.com/en-us/graph/api/site-search?view=graph-rest-1.0
  // (and the `$skiptoken` of Graph's own next link).
  { path: /^\/v1\.0\/sites$/u, options: ["search", "$skiptoken"] },
  // https://learn.microsoft.com/en-us/graph/api/site-get?view=graph-rest-1.0
  { path: /^\/v1\.0\/sites\/root$/u, options: ["$select", "$expand"] },
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
  sitePages: { id: string; displayName: string; webUrl?: string }[][];
  /** The root site's address, as Graph gives it. */
  rootWebUrl: string;
  /** The sites, by path, whose permissions the account may read (an owner). */
  owners: Set<string>;
  /**
   * Each list item's role assignments (`<list>|<item>`), or a refusal, or
   * a list SharePoint pages.
   */
  assignments: Record<string, unknown[] | "paged">;
  /** Each SharePoint group's users (`<site path>|<id>`), or hidden ("refused"). */
  groups: Record<string, unknown[] | "refused">;
  /** Each site's drives. */
  drives: Record<string, Library[]>;
  /**
   * How many of a site's drives Graph answers a page, as it may ("The
   * service may return fewer"): all of them when unset.
   */
  drivesPerPage?: number;
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
  rootWebUrl: "",
  owners: new Set(),
  assignments: {},
  groups: {},
  drives: {},
  feeds: {},
  contents: {},
};

/** Each library's site, by its path on the company's host, and its list. */
const whereIs: Record<string, { site: string; list: string }> = {
  "b!sales-docs": {
    site: "/sites/sales",
    list: "11111111-1111-4111-8111-111111111111",
  },
  "b!sales-contracts": {
    site: "/sites/sales",
    list: "22222222-2222-4222-8222-222222222222",
  },
  "b!legal-docs": {
    site: "/sites/legal",
    list: "33333333-3333-4333-8333-333333333333",
  },
};

/** SharePoint's roles, by their base permissions as REST gives them. */
const roles = {
  fullControl: { BasePermissions: { High: "2147483647", Low: "4294967295" } },
  edit: { BasePermissions: { High: "432", Low: "1011030767" } },
  read: { BasePermissions: { High: "176", Low: "138612833" } },
  // Lets someone reach an item shared below it, not read the library.
  limitedAccess: { BasePermissions: { High: "0", Low: "134287360" } },
};

/** A user as SharePoint names one, with their Entra object ID. */
const spUser = (id: number, name: string, oid?: string) => ({
  Id: id,
  LoginName: `i:0#.f|membership|${name}@acme.test`,
  PrincipalType: 1,
  ...(oid === undefined ? {} : { AadObjectId: { NameId: oid } }),
});

/** A SharePoint group, as a role assignment names it. */
const spGroup = (id: number, name: string) => ({
  Id: id,
  LoginName: name,
  PrincipalType: 8,
});

/** Entra object IDs of the site's people. */
const ada = "aaaaaaaa-0000-4000-8000-000000000001";
const ben = "bbbbbbbb-0000-4000-8000-000000000002";

/** Graph's clock, as its `Date` header gives it. */
const graphDate = "Tue, 17 Nov 2026 10:00:00 GMT";
/** When a listing began, by Graph's clock, as a timestamp token. */
const listedAt = "2026-11-17T10:00:00Z";

/** A file in `library`, list item `item` of its list. */
const fileIn = (
  library: Library,
  id: string,
  fields: Record<string, unknown> = {},
  item = "1"
): Entry => ({
  id,
  name: `${id}.pdf`,
  eTag: `"{${id}},1"`,
  lastModifiedDateTime: "2026-11-10T09:00:00Z",
  size: 8,
  file: { mimeType: "application/pdf" },
  parentReference: { driveId: library.id },
  lastModifiedBy: { user: { id: "5D33DD65-0000-4000-8000-000000000001" } },
  ...(whereIs[library.id] === undefined
    ? {}
    : {
        sharepointIds: {
          siteUrl: `https://${storageHost}${whereIs[library.id]?.site ?? ""}`,
          listId: whereIs[library.id]?.list,
          listItemId: item,
        },
      }),
  ...fields,
});

const reset = (): void => {
  sharePoint.drivesPerPage = undefined;
  sharePoint.sitePages = [
    [
      {
        id: salesSite,
        displayName: "Sales",
        webUrl: `https://${storageHost}/sites/sales`,
      },
      { id: personalSite, displayName: "Owner's OneDrive" },
    ],
    [
      {
        id: legalSite,
        displayName: "Legal",
        webUrl: `https://${storageHost}/sites/legal`,
      },
    ],
  ];
  sharePoint.rootWebUrl = `https://${storageHost}`;
  // The account owns Sales; in Legal it is a member.
  sharePoint.owners = new Set(["/sites/sales"]);
  // Each library's file inherits its site's: its Members and its Owners.
  sharePoint.assignments = Object.fromEntries(
    Object.values(whereIs).map(({ list }) => [
      `${list}|1`,
      [
        {
          Member: spGroup(3, "Sales Members"),
          RoleDefinitionBindings: [roles.edit],
        },
        {
          Member: spGroup(4, "Sales Owners"),
          RoleDefinitionBindings: [roles.fullControl],
        },
      ],
    ])
  );
  sharePoint.groups = {
    "/sites/sales|3": [spUser(10, "ada", ada)],
    "/sites/sales|4": [spUser(11, "ben", ben)],
  };
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
    if (drives === undefined || !selectsOnly(url, driveProperties)) {
      return itemNotFound();
    }
    // Graph's position in the site's drives, as its next link carries it.
    const from = Number(url.searchParams.get("$skiptoken") ?? 0);
    const size = sharePoint.drivesPerPage ?? drives.length;
    const next = from + size;
    return Response.json({
      value: drives.slice(from, next),
      ...(next < drives.length
        ? {
            "@odata.nextLink": `https://${graphHost}/v1.0/sites/${encodeURIComponent(decoded)}/drives?$select=id,name,driveType&$skiptoken=${next}`,
          }
        : {}),
    });
  }
  const library = libraryOf(decoded);
  return kind === "drives" && library !== undefined
    ? driveCall(library, rest, url)
    : itemNotFound();
};

/** The base permissions of a site's web, for the account. */
const effectivePermissions = (site: string): Response =>
  Response.json(
    sharePoint.owners.has(site)
      ? roles.fullControl.BasePermissions
      : roles.edit.BasePermissions
  );

const accessDenied = (): Response =>
  Response.json(
    {
      "odata.error": {
        code: "-2147024891, System.UnauthorizedAccessException",
      },
    },
    { status: 403 }
  );

/**
 * SharePoint's REST API on the company's host
 * (https://learn.microsoft.com/en-us/sharepoint/dev/sp-add-ins/set-custom-permissions-on-a-list-by-using-the-rest-interface):
 * a web's effective permissions, a list item's role assignments, which
 * only someone who may enumerate its permissions reads, and a group's
 * users, which a group that shows its members to its members alone hides.
 */
const restCall = (url: URL): Response => {
  const match =
    /^(?<site>(?:\/(?:sites|teams)\/[^/]+)?)\/_api\/web\/(?<rest>.+)$/u.exec(
      decodeURIComponent(url.pathname)
    );
  const site = match?.groups?.site ?? "";
  const rest = match?.groups?.rest ?? "";
  if (rest === "effectiveBasePermissions") {
    return effectivePermissions(site);
  }
  const item =
    /^lists\(guid'(?<list>[^']+)'\)\/items\((?<item>\d+)\)\/roleassignments$/u.exec(
      rest
    )?.groups;
  if (item !== undefined) {
    if (url.searchParams.get("$expand") !== "Member,RoleDefinitionBindings") {
      return invalid();
    }
    if (!sharePoint.owners.has(site)) {
      return accessDenied();
    }
    const held = sharePoint.assignments[`${item.list}|${item.item}`] ?? [];
    return held === "paged"
      ? Response.json({
          value: [],
          "odata.nextLink": `${url.href}&$skiptoken=1`,
        })
      : Response.json({ value: held });
  }
  const group = /^sitegroups\/getbyid\((?<id>\d+)\)\/users$/u.exec(rest)?.groups
    ?.id;
  if (group !== undefined) {
    const users = sharePoint.groups[`${site}|${group}`] ?? [];
    return users === "refused"
      ? accessDenied()
      : Response.json({ value: users });
  }
  return itemNotFound();
};

const internet = fakeInternet((_request, url) => {
  if (url.hostname === storageHost && url.pathname.includes("/_api/")) {
    return restCall(url);
  }
  if (url.hostname === graphHost && url.pathname === "/v1.0/sites/root") {
    return Response.json({ webUrl: sharePoint.rootWebUrl });
  }
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
    from: await heldPicks(connectionId, feed),
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

/** The readers of each item a whole read of `place` gives: none for one gone. */
const readersRead = async (connectionId: string, place: string) => {
  const { items } = await readAll(connectionId, place);
  return items.map((item) => (item.gone ? undefined : item.readers));
};

describe("syncing a shared connection's picked SharePoint libraries", () => {
  it("shows an admin the document libraries of the sites the account finds, whether it may read who opens their files, never a OneDrive", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, [salesContracts.id, legalDocs.id]);

    const choices = await exports.default.syncPlaceChoices({
      person: admin,
      connectionId,
      feed,
      cursor: null,
    });
    expect({
      // Every pick, in no order of note.
      choices:
        choices === null
          ? null
          : { ...choices, picks: [...choices.picks].toSorted() },
      places: await exports.default.listSyncPlaces({
        connectionId,
        feed,
        cursor: null,
      }),
    }).toStrictEqual({
      choices: {
        feed: "libraries",
        choices: [
          {
            place: salesDocs.id,
            title: "Documents",
            within: "Sales",
            // The account owns Sales.
            sharingRead: true,
            picked: false,
          },
          {
            place: salesContracts.id,
            title: "Contracts",
            within: "Sales",
            sharingRead: true,
            picked: true,
          },
          {
            place: legalDocs.id,
            title: "Documents",
            within: "Legal",
            // A member of Legal, not its owner.
            sharingRead: false,
            picked: true,
          },
        ],
        picks: [salesContracts.id, legalDocs.id].toSorted(),
        cursor: null,
      },
      places: { places: [salesContracts.id, legalDocs.id], cursor: null },
    });
  });

  it("lists a site with more pages of drives than one read can take, across reads, every library once, no read past its requests", async () => {
    const { admin, connectionId } = await sharedConnection();
    // One drive a page: a read's room (`connectorIsolateRequests`, less
    // the page of sites each read starts from) holds 49 of them. Sizes
    // around that, and one that takes three reads.
    const sizes = [48, 49, 50, 101];
    const sites = sizes.map((size, at) => ({
      id: `acme.sharepoint.com,site-${at},web`,
      displayName: `Site ${size}`,
      size,
    }));
    sharePoint.sitePages = [
      sites.map(({ id, displayName }) => ({ id, displayName })),
    ];
    sharePoint.drives = Object.fromEntries(
      sites.map(({ id, size }, at) => [
        id,
        Array.from({ length: size }, (_, index) => ({
          id: `b!s${at}-${index}`,
          name: `Library ${index}`,
          driveType: "documentLibrary",
        })),
      ])
    );
    sharePoint.drivesPerPage = 1;

    const listed: string[] = [];
    const perRead: number[] = [];
    let cursor: string | null = null;
    // Connect's own read of the company's root site, once a grant, for
    // its SharePoint host (tokens.ts `tenantCredentialFor`), isn't the
    // connector's.
    const connectorsGraph = () =>
      internet.sent.filter(
        ({ host, path }) =>
          host === graphHost && !path.startsWith("/v1.0/sites/root")
      ).length;
    for (;;) {
      const before = connectorsGraph();
      // oxlint-disable-next-line no-await-in-loop -- one read after another, each from the last one's cursor
      const answer = await exports.default.syncPlaceChoices({
        person: admin,
        connectionId,
        feed,
        cursor,
      });
      perRead.push(connectorsGraph() - before);
      listed.push(...(answer?.choices ?? []).map(({ place }) => place));
      cursor = answer?.cursor ?? null;
      if (cursor === null) {
        break;
      }
      // Each read must move on: far fewer reads than this list every one.
      if (perRead.length > 20) {
        throw new Error("The listing never ended");
      }
    }

    const expected = sites.flatMap(({ size }, at) =>
      Array.from({ length: size }, (_, index) => `b!s${at}-${index}`)
    );
    expect({
      listed,
      // `connectorIsolateRequests`: what connect loads a connector's
      // isolate with.
      overLimit: perRead.filter((requests) => requests > 50),
      reads: perRead.length > 1,
    }).toStrictEqual({ listed: expected, overLimit: [], reads: true });
  });

  it("reads a picked library whole, catches up from when it began, then its changes, each file read by those SharePoint lets open it", async () => {
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
        // The site's Members and Owners, each SharePoint group's users.
        readers: [
          { kind: "account", id: ada },
          { kind: "account", id: ben },
        ],
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
    // Readable where it now is: only its other drive makes it gone here.
    sharePoint.contents.moved = "moved bytes";
    const changes = await readAll(connectionId, salesDocs.id, listing.cursor);
    expect(changes.items).toStrictEqual([
      expect.objectContaining({
        id: "plan",
        version: '"{plan},2"',
        readers: [
          { kind: "account", id: ada },
          { kind: "account", id: ben },
        ],
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

  it("reads who may open a file from its role assignments: only roles that view items, each group's members, and a link for anyone or the whole organisation", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, [salesDocs.id]);
    const { list } = whereIs[salesDocs.id] ?? { list: "" };
    const [kim, lee] = [
      "cccccccc-0000-4000-8000-000000000003",
      "dddddddd-0000-4000-8000-000000000004",
    ];
    const [entraGroup, teamGroup, otherTeam] = [
      "eeeeeeee-0000-4000-8000-000000000005",
      "ffffffff-0000-4000-8000-000000000006",
      "99999999-0000-4000-8000-000000000007",
    ];
    sharePoint.assignments[`${list}|1`] = [
      {
        Member: spGroup(5, "Sales Members"),
        RoleDefinitionBindings: [roles.edit],
      },
      // Reaches something shared below it, not the file.
      {
        Member: spUser(12, "lee", lee),
        RoleDefinitionBindings: [roles.limitedAccess],
      },
      {
        Member: {
          Id: 13,
          LoginName: `c:0-.f|rolemanager|spo-grid-all-users/${acmeTenant}`,
          PrincipalType: 4,
        },
        RoleDefinitionBindings: [roles.read],
      },
      {
        Member: { Id: 14, LoginName: "c:0(.s|true", PrincipalType: 4 },
        RoleDefinitionBindings: [roles.read],
      },
      // A link for the organisation, and one for specific people.
      {
        Member: spGroup(15, "SharingLinks.0a.OrganizationView.0b"),
        RoleDefinitionBindings: [roles.read],
      },
      {
        Member: spGroup(16, "SharingLinks.0c.Flexible.0d"),
        RoleDefinitionBindings: [roles.read],
      },
    ];
    sharePoint.groups["/sites/sales|5"] = [
      spUser(10, "ada", ada),
      { Id: 20, LoginName: `c:0t.c|tenant|${entraGroup}`, PrincipalType: 4 },
      {
        Id: 21,
        LoginName: `c:0o.c|federateddirectoryclaimprovider|${teamGroup}`,
        PrincipalType: 4,
      },
      // A group's owners, and a user without an Entra object ID: nobody.
      {
        Id: 22,
        LoginName: `c:0o.c|federateddirectoryclaimprovider|${otherTeam}_o`,
        PrincipalType: 4,
      },
      spUser(23, "old"),
    ];
    sharePoint.groups["/sites/sales|16"] = [spUser(24, "kim", kim)];

    const { items } = await readAll(connectionId, salesDocs.id);

    expect(
      items.map((item) => (item.gone ? null : item.readers))
    ).toStrictEqual([
      [
        { kind: "account", id: ada },
        { kind: "group", id: entraGroup },
        { kind: "group", id: teamGroup },
        { kind: "tenant", id: acmeTenant },
        { kind: "link" },
        { kind: "account", id: kim },
      ],
    ]);
  });

  it("gives nobody a file whose role assignments or group members SharePoint won't give whole", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, [
      salesDocs.id,
      salesContracts.id,
      legalDocs.id,
    ]);
    // Members a group shows to its members alone.
    sharePoint.assignments[`${whereIs[salesContracts.id]?.list ?? ""}|1`] = [
      { Member: spGroup(6, "Board"), RoleDefinitionBindings: [roles.read] },
    ];
    sharePoint.groups["/sites/sales|6"] = "refused";
    // A list SharePoint pages.
    sharePoint.assignments[`${whereIs[salesDocs.id]?.list ?? ""}|1`] = "paged";

    expect({
      paged: await readersRead(connectionId, salesDocs.id),
      hidden: await readersRead(connectionId, salesContracts.id),
      // The account isn't Legal's owner: SharePoint refuses its sharing.
      notOwner: await readersRead(connectionId, legalDocs.id),
    }).toStrictEqual({ paged: [null], hidden: [null], notOwner: [null] });
  });

  it("sends SharePoint's token only to the company's own SharePoint host and Graph's only to Graph, asking for SharePoint's once a grant", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, [salesDocs.id]);

    await readAll(connectionId, salesDocs.id);
    await readAll(connectionId, salesDocs.id);
    const tokensAt = (host: string, rest: boolean) =>
      new Set(
        internet.sent
          .filter(
            ({ host: to, path }) =>
              to === host && path.includes("/_api/") === rest
          )
          .map(({ headers }) => headers.authorization)
      );
    const graph = tokensAt(graphHost, false);
    const sharePointTokens = tokensAt(storageHost, true);
    const asked = providers
      .tokenRequests("refresh_token")
      .map(({ form }) => form.get("scope"));

    // A file Graph says lives on another company's SharePoint host.
    const otherHost = "other.sharepoint.com";
    sharePoint.feeds[salesDocs.id] = {
      ...sharePoint.feeds[salesDocs.id],
      "": {
        entries: [
          fileIn(salesDocs, "foreign", {
            sharepointIds: {
              siteUrl: `https://${otherHost}/sites/sales`,
              listId: whereIs[salesDocs.id]?.list,
              listItemId: "1",
            },
          }),
        ],
        end: "t1",
      },
    };
    sharePoint.contents.foreign = "foreign";
    const foreign = await readersRead(connectionId, salesDocs.id);

    expect({
      foreign,
      toOtherHost: internet.sent.filter(({ host }) => host === otherHost),
      apart: [...sharePointTokens].filter((token) => graph.has(token)),
      sharePoint: sharePointTokens.size,
      asked,
      // A download's redirect carries no token at all.
      downloads: internet.sent
        .filter(({ path }) => path.startsWith("/download/"))
        .map(({ headers }) => headers.authorization ?? null),
    }).toStrictEqual({
      foreign: [null],
      toOtherHost: [],
      apart: [],
      sharePoint: 1,
      asked: [`https://${storageHost}/AllSites.Read`],
      downloads: [null, null, null],
    });
  });

  it("reads nobody, and sends nothing to SharePoint, for a grant that doesn't reach it or a root site off SharePoint", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, [salesDocs.id]);
    // A connection made before SharePoint's right was asked for.
    providers.state.refresh = () => providers.oauthError("consent_required");
    let notConsented: unknown;
    let choices: unknown;
    try {
      notConsented = await readersRead(connectionId, salesDocs.id);
      const listed = await exports.default.syncPlaceChoices({
        person: admin,
        connectionId,
        feed,
        cursor: null,
      });
      choices = listed?.choices.map(({ sharingRead }) => sharingRead);
    } finally {
      providers.state.refresh = undefined;
    }
    const restBefore = internet.sent.filter(({ path }) =>
      path.includes("/_api/")
    ).length;

    const { connectionId: elsewhere } = await sharedConnection();
    await pick(admin, elsewhere, [salesDocs.id]);
    sharePoint.rootWebUrl = "https://files.example.com";
    const offSharePoint = await readersRead(elsewhere, salesDocs.id);

    expect({
      notConsented,
      choices,
      offSharePoint,
      // No token was ever asked for a host off SharePoint.
      askedOff: providers
        .tokenRequests("refresh_token")
        .filter(({ form }) =>
          (form.get("scope") ?? "").includes("example.com")
        ),
      rest: restBefore,
      restAfter: internet.sent.filter(({ path }) => path.includes("/_api/"))
        .length,
    }).toStrictEqual({
      notConsented: [null],
      choices: [false, false, false],
      offSharePoint: [null],
      askedOff: [],
      rest: 0,
      restAfter: 0,
    });
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
        .filter(
          (path) =>
            path !== "/v1.0/sites" &&
            // Connect's own read of the root site, for its SharePoint host.
            path !== "/v1.0/sites/root" &&
            !path.endsWith("/drives")
        ),
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
