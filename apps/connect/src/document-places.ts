import { connectErrors, connectionErrors } from "@grasp-os/shared/connect";
import {
  placeErrors,
  placeFileRequestSchema,
  placeItemsRequestSchema,
  placesLimits,
  placesProviderSchema,
  placesReadRequestSchema,
} from "@grasp-os/shared/document-places";
import type {
  DocumentPlace,
  PlaceFile,
  PlaceItem,
  PlaceItemsRead,
  PlacesConnection,
  PlacesProvider,
  PlacesRead,
} from "@grasp-os/shared/document-places";
import { uploadMaxBytes } from "@grasp-os/shared/uploads";
import { and, eq, inArray, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { connections } from "./db/schema.ts";
import {
  SourceError,
  bytesFromProvider,
  readFromProvider,
  requestBudget,
} from "./event-kinds.ts";
import type { ProviderAccess } from "./event-kinds.ts";
import { accessTokenFor } from "./tokens.ts";

// The documents' reads (GRA-370): where the company's documents live, in
// SharePoint and OneDrive or in Google Drive, with the documents
// connection's token, which stays here. In the onboarding's documents
// step the admin lists the places, opens a folder or searches one, and
// picks files, which core reads as dropped ones. Threat model, before
// code:
//
// - A token reaching more than files, or writing: its connection has an
//   app of its own at the provider and is kept only with exactly its
//   read scopes (oauth.ts, `grantedAsAsked`), so it can't read mail or
//   calendars, or change a file; it takes no connector calls (call.ts, no
//   connector can name its provider); and it is sent only to the
//   provider's own API host. A request is built here every time, from
//   IDs in the provider's own alphabet: none can reach another path or
//   break out of a Drive query's quotes. A cursor is only the provider's
//   position, set as a parameter, never a link to follow.
// - More read than was picked: a folder or a search answers names, kinds,
//   sizes and dates, never content; only a file the admin picked is
//   fetched, one at a time, and nothing is kept or indexed here.
// - A file outside the place it was picked in: its metadata is read
//   first, and a file of another drive, in the bin, or no file at all is
//   refused before any content is fetched.
// - SharePoint's download link: Graph hands one back, signed, on
//   SharePoint's own hosts. It is fetched without the token, only on
//   `*.sharepoint.com`, over HTTPS, following no redirect.
// - Planted names: anyone who can save a file can name it anything.
//   Names are cut, without control or format characters, and are only
//   data; characters a file name may not hold here become dashes.
// - A flood: a read asks for `itemsPerRead` items and sends one request
//   (a fetch two); a page holding more than it asked for is refused; a
//   file larger than an upload may be is refused, by its size and by
//   its bytes.
// - Another tenant's files: only a documents connection is read, and each
//   read says its tenant, which core checks against its own.

const graphHost = "graph.microsoft.com";
const googleHost = "www.googleapis.com";

/** Each provider's API, sent the token: only on its own host, over HTTPS. */
const graph = readFromProvider({ name: "Microsoft Graph", hosts: [graphHost] });
const googleDrive = { name: "Google Drive", hosts: [googleHost] };
const drive = readFromProvider(googleDrive);
const driveBytes = bytesFromProvider(googleDrive);

/** How long fetching a file from SharePoint may take. */
const downloadTimeoutMs = 30_000;

/** The place that is the admin's own OneDrive, and their My Drive. */
const oneDrive = "me";
const myDrive = "my-drive";

/** A SharePoint site's ID, as Graph writes it: its host, its collection and its web. */
const sitePattern =
  /^[a-z\d.-]+,[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12},[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
/**
 * An item's ID at Graph, in Graph's alphabet, starting with a letter or a
 * digit: never a path's `.` or `..`.
 */
const graphIdPattern = /^[\da-z][\w=!.-]*$/iu;
/** A file's, a folder's or a shared drive's ID at Google. */
const googleIdPattern = /^[\w-]+$/u;

/**
 * Control and format characters, bidirectional overrides among them: what
 * could make a planted name show as something else.
 */
const invisible = /[\p{Cc}\p{Cf}]/gu;
const spaces = /\s+/gu;
/** What a file name may not hold here (uploads.ts): it becomes a dash. */
const notInName = /[/\\[\]#|]/gu;
/** A name's extension, as a file keeps it. */
const extensionPattern = /\.(?<extension>[a-z\d]{1,8})$/iu;

/** Text as kept: without control or format characters, on one line, trimmed and cut. */
const textOf = (text: string | null | undefined, most: number): string =>
  (text ?? "")
    .replaceAll(spaces, " ")
    .replaceAll(invisible, "")
    .trim()
    .slice(0, most)
    .trim();

/**
 * A file's name as it is shared: kept as data, cut, and ending in the
 * extension of what it is fetched as (`as`, for Google's own formats) or
 * its own.
 */
const fileNameOf = (name: string, as?: string): string => {
  const tidy = textOf(name, Number.POSITIVE_INFINITY).replaceAll(
    notInName,
    "-"
  );
  const own = extensionPattern.exec(tidy)?.groups?.extension;
  const extension = as ?? own;
  const base =
    as === undefined && own !== undefined
      ? tidy.slice(0, -own.length - 1)
      : tidy;
  const room = placesLimits.nameLength - (extension?.length ?? -1) - 1;
  const cut = textOf(base, room);
  const named = cut === "" || cut === "." || cut === ".." ? "Untitled" : cut;
  return extension === undefined ? named : `${named}.${extension}`;
};

const graphItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative().nullish(),
  lastModifiedDateTime: z.string().nullish(),
  file: z.object({}).nullish(),
  folder: z.object({}).nullish(),
});

const graphPageSchema = z.object({
  value: z.array(graphItemSchema),
  "@odata.nextLink": z.string().optional(),
});

const graphSitesSchema = z.object({
  value: z.array(
    z.object({
      id: z.string(),
      displayName: z.string().nullish(),
      name: z.string().nullish(),
    })
  ),
});

const graphFileSchema = graphItemSchema.extend({
  "@microsoft.graph.downloadUrl": z.string().nullish(),
});

const googleFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  /** In bytes, as a string (an int64); none for Google's own formats. */
  size: z.string().regex(/^\d+$/u).nullish(),
  modifiedTime: z.string().nullish(),
  driveId: z.string().nullish(),
  trashed: z.boolean().nullish(),
});
type GoogleFile = z.output<typeof googleFileSchema>;

const googlePageSchema = z.object({
  files: z.array(googleFileSchema).nullish(),
  nextPageToken: z.string().nullish(),
});

const googleDrivesSchema = z.object({
  drives: z
    .array(z.object({ id: z.string(), name: z.string().nullish() }))
    .nullish(),
});

const googleFolder = "application/vnd.google-apps.folder";

/** Google's own formats, as the file each is fetched as, read as a dropped one is. */
const googleExports: Readonly<
  Record<string, { mimeType: string; extension: string }>
> = {
  "application/vnd.google-apps.document": {
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: "docx",
  },
  "application/vnd.google-apps.spreadsheet": {
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
  },
  // Slides aren't read; a PDF of them is.
  "application/vnd.google-apps.presentation": {
    mimeType: "application/pdf",
    extension: "pdf",
  },
};

const exportOf = (
  mimeType: string
): { mimeType: string; extension: string } | undefined =>
  Object.hasOwn(googleExports, mimeType) ? googleExports[mimeType] : undefined;

/** Whether `place` names a place of `provider`. */
const isPlace = (provider: PlacesProvider, place: string): boolean =>
  provider === "microsoft-documents"
    ? place === oneDrive || sitePattern.test(place)
    : place === myDrive || googleIdPattern.test(place);

/** Whether `id` names a folder or a file of `provider`. */
const isItem = (provider: PlacesProvider, id: string): boolean =>
  provider === "microsoft-documents"
    ? graphIdPattern.test(id)
    : googleIdPattern.test(id);

/** A place's drive at Graph: the admin's OneDrive, or a site's documents. */
const graphDrive = (place: string): string =>
  place === oneDrive ? "/v1.0/me/drive" : `/v1.0/sites/${place}/drive`;

const graphUrl = (path: string, params: Record<string, string>): URL => {
  const url = new URL(`https://${graphHost}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
};

const googleUrl = (path: string, params: Record<string, string>): URL => {
  const url = new URL(`https://${googleHost}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
};

/** A value inside a Drive query's quotes: `\` and `'` escaped. */
const quoted = (value: string): string =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

/** Whether a file of Google's is in `place`, as Google says. */
const isInPlace = (place: string, file: GoogleFile): boolean =>
  place === myDrive ? (file.driveId ?? null) === null : file.driveId === place;

const graphItem = (
  item: z.output<typeof graphItemSchema>
): PlaceItem | null => {
  if (!graphIdPattern.test(item.id) || item.id.length > placesLimits.idLength) {
    return null;
  }
  if (!item.folder && !item.file) {
    return null;
  }
  const kind = item.folder ? "folder" : "file";
  return {
    id: item.id,
    name:
      kind === "folder"
        ? textOf(item.name, placesLimits.nameLength)
        : fileNameOf(item.name),
    kind,
    size: kind === "file" ? (item.size ?? null) : null,
    modifiedAt: item.lastModifiedDateTime ?? null,
  };
};

const googleItem = (place: string, file: GoogleFile): PlaceItem | null => {
  if (
    !googleIdPattern.test(file.id) ||
    file.id.length > placesLimits.idLength ||
    file.trashed === true ||
    !isInPlace(place, file)
  ) {
    return null;
  }
  const modifiedAt = file.modifiedTime ?? null;
  if (file.mimeType === googleFolder) {
    return {
      id: file.id,
      name: textOf(file.name, placesLimits.nameLength),
      kind: "folder",
      size: null,
      modifiedAt,
    };
  }
  const exported = exportOf(file.mimeType);
  // Forms, drawings, shortcuts and the like: nothing to read.
  if (
    exported === undefined &&
    file.mimeType.startsWith("application/vnd.google-apps.")
  ) {
    return null;
  }
  return {
    id: file.id,
    name: fileNameOf(file.name, exported?.extension),
    kind: "file",
    size: typeof file.size === "string" ? Number(file.size) : null,
    modifiedAt,
  };
};

/** The places of Microsoft 365: the admin's OneDrive, and the SharePoint sites they can open. */
const graphPlaces = async (
  access: ProviderAccess
): Promise<DocumentPlace[]> => {
  const { value } = graphSitesSchema.parse(
    await graph(
      access,
      graphUrl("/v1.0/sites", {
        search: "*",
        $select: "id,displayName,name",
        $top: String(placesLimits.placesPerRead),
      }).href
    )
  );
  const sites = value.flatMap((site): DocumentPlace[] => {
    const name = textOf(site.displayName ?? site.name, placesLimits.nameLength);
    // Someone's OneDrive is a site too, on the `-my` host: not a place.
    const personal = site.id.split(",")[0]?.endsWith("-my.sharepoint.com");
    return sitePattern.test(site.id) && personal !== true && name !== ""
      ? [{ id: site.id, name, kind: "site" }]
      : [];
  });
  return [
    { id: oneDrive, name: "OneDrive", kind: "onedrive" },
    ...sites.slice(0, placesLimits.placesPerRead),
  ];
};

/** The places of Google Drive: the admin's My Drive, and the shared drives they're in. */
const googlePlaces = async (
  access: ProviderAccess
): Promise<DocumentPlace[]> => {
  const { drives } = googleDrivesSchema.parse(
    await drive(
      access,
      googleUrl("/drive/v3/drives", {
        pageSize: String(placesLimits.placesPerRead),
        fields: "drives(id,name)",
      }).href
    )
  );
  const shared = (drives ?? []).flatMap((each): DocumentPlace[] => {
    const name = textOf(each.name, placesLimits.nameLength);
    return googleIdPattern.test(each.id) &&
      each.id.length <= placesLimits.idLength &&
      name !== ""
      ? [{ id: each.id, name, kind: "shared-drive" }]
      : [];
  });
  return [
    { id: myDrive, name: "My Drive", kind: "my-drive" },
    ...shared.slice(0, placesLimits.placesPerRead),
  ];
};

interface ItemsAsked {
  place: string;
  folder: string | null;
  query: string | null;
  cursor: string | null;
}

/** One page of a folder of a place at Graph, or of a search of it. */
const graphItems = async (
  access: ProviderAccess,
  { place, folder, query, cursor }: ItemsAsked
): Promise<{ items: PlaceItem[]; next: string | null; read: number }> => {
  const base = graphDrive(place);
  let path = `${base}/root/children`;
  if (query !== null) {
    // OData quotes a quote by doubling it.
    path = `${base}/root/search(q='${encodeURIComponent(query.replaceAll("'", "''"))}')`;
  } else if (folder !== null) {
    path = `${base}/items/${folder}/children`;
  }
  const url = graphUrl(path, {
    $select: "id,name,size,lastModifiedDateTime,file,folder",
    $top: String(placesLimits.itemsPerRead),
  });
  if (cursor !== null) {
    url.searchParams.set("$skiptoken", cursor);
  }
  const page = graphPageSchema.parse(await graph(access, url.href));
  const nextLink = page["@odata.nextLink"];
  let next: string | null = null;
  if (nextLink !== undefined) {
    // Only the position is taken from Graph's link, never the link.
    const link = new URL(nextLink);
    next = link.host === graphHost ? link.searchParams.get("$skiptoken") : null;
    if (next === null || next === "") {
      throw placeErrors.create("place.provider_failed");
    }
  }
  return {
    items: page.value.flatMap((item) => graphItem(item) ?? []),
    next,
    read: page.value.length,
  };
};

/** One page of a folder of a place at Google, or of a search of it. */
const googleItems = async (
  access: ProviderAccess,
  { place, folder, query, cursor }: ItemsAsked
): Promise<{ items: PlaceItem[]; next: string | null; read: number }> => {
  const top = place === myDrive ? "root" : place;
  const where =
    query === null
      ? `${quoted(folder ?? top)} in parents and trashed = false`
      : `fullText contains ${quoted(query)} and trashed = false`;
  const url = googleUrl("/drive/v3/files", {
    ...(place === myDrive
      ? { corpora: "user" }
      : {
          corpora: "drive",
          driveId: place,
          includeItemsFromAllDrives: "true",
          supportsAllDrives: "true",
        }),
    q: where,
    // Drive orders no full-text search.
    ...(query === null ? { orderBy: "folder,name" } : {}),
    pageSize: String(placesLimits.itemsPerRead),
    fields:
      "nextPageToken,files(id,name,mimeType,size,modifiedTime,driveId,trashed)",
  });
  if (cursor !== null) {
    url.searchParams.set("pageToken", cursor);
  }
  const page = googlePageSchema.parse(await drive(access, url.href));
  const files = page.files ?? [];
  const token = page.nextPageToken ?? "";
  return {
    items: files.flatMap((file) => googleItem(place, file) ?? []),
    next: token === "" ? null : token,
    read: files.length,
  };
};

/** A file's bytes from SharePoint's signed link: without the token, on SharePoint's hosts alone. */
const sharePointBytes = async (link: string): Promise<Uint8Array> => {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw placeErrors.create("place.provider_failed");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".sharepoint.com") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw placeErrors.create("place.provider_failed");
  }
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(downloadTimeoutMs),
  });
  if (!response.ok) {
    throw new SourceError(`SharePoint answered ${response.status}`, {
      status: response.status,
    });
  }
  if (Number(response.headers.get("content-length") ?? 0) > uploadMaxBytes) {
    throw placeErrors.create("place.too_large");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > uploadMaxBytes) {
    throw placeErrors.create("place.too_large");
  }
  return new Uint8Array(bytes);
};

/** A picked file of a place at Graph: its metadata first, then its bytes. */
const graphFile = async (
  access: ProviderAccess,
  place: string,
  id: string
): Promise<{ name: string; bytes: Uint8Array }> => {
  const item = graphFileSchema.parse(
    await graph(access, graphUrl(`${graphDrive(place)}/items/${id}`, {}).href)
  );
  if (item.id !== id) {
    throw placeErrors.create("place.no_item");
  }
  const link = item["@microsoft.graph.downloadUrl"];
  if (!item.file || link === undefined || link === null) {
    throw placeErrors.create("place.not_a_file");
  }
  if ((item.size ?? 0) > uploadMaxBytes) {
    throw placeErrors.create("place.too_large");
  }
  return { name: fileNameOf(item.name), bytes: await sharePointBytes(link) };
};

/** A picked file of a place at Google: its metadata first, then its bytes or its export. */
const googleFile = async (
  access: ProviderAccess,
  place: string,
  id: string
): Promise<{ name: string; bytes: Uint8Array }> => {
  const path = `/drive/v3/files/${id}`;
  const file = googleFileSchema.parse(
    await drive(
      access,
      googleUrl(path, {
        supportsAllDrives: "true",
        fields: "id,name,mimeType,size,modifiedTime,driveId,trashed",
      }).href
    )
  );
  if (file.id !== id || file.trashed === true || !isInPlace(place, file)) {
    throw placeErrors.create("place.no_item");
  }
  const item = googleItem(place, file);
  if (item?.kind !== "file") {
    throw placeErrors.create("place.not_a_file");
  }
  if ((item.size ?? 0) > uploadMaxBytes) {
    throw placeErrors.create("place.too_large");
  }
  const exported = exportOf(file.mimeType);
  const url =
    exported === undefined
      ? googleUrl(path, { alt: "media", supportsAllDrives: "true" })
      : googleUrl(`${path}/export`, { mimeType: exported.mimeType });
  return {
    name: item.name,
    bytes: await driveBytes(access, url.href, uploadMaxBytes),
  };
};

/** The documents' connections still connected, for core. */
export const placesConnections = async (
  env: Env
): Promise<PlacesConnection[]> => {
  const rows = await drizzle(env.DB)
    .select({
      id: connections.id,
      provider: connections.provider,
      tenant: connections.tenant,
      status: connections.status,
      createdAt: connections.createdAt,
    })
    .from(connections)
    .where(
      and(
        inArray(connections.provider, placesProviderSchema.options),
        ne(connections.status, "disconnected")
      )
    );
  return rows.flatMap(({ id, provider, tenant, status, createdAt }) => {
    const known = placesProviderSchema.safeParse(provider);
    return known.success && tenant !== null && status !== "disconnected"
      ? [
          {
            id,
            provider: known.data,
            tenant,
            status,
            connectedAt: createdAt.toISOString(),
          },
        ]
      : [];
  });
};

/**
 * A documents connection, ready to read: its provider, its tenant and its
 * access, for `requests` requests. Any other kind of connection is
 * `place.not_found`; one that needs reconnecting, `place.inactive`.
 */
const accessOf = async (
  env: Env,
  connectionId: string,
  requests: number
): Promise<{
  provider: PlacesProvider;
  tenant: string;
  access: ProviderAccess;
}> => {
  const connection = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  const provider = placesProviderSchema.safeParse(connection?.provider);
  if (
    connection === undefined ||
    !provider.success ||
    connection.tenant === null
  ) {
    throw placeErrors.create("place.not_found");
  }
  if (connection.status !== "active") {
    throw placeErrors.create("place.inactive");
  }
  let token: string;
  try {
    token = await accessTokenFor(env, connection.id);
  } catch (error) {
    // A grant that ran out, or a renewal granted other access, is for an
    // admin to reconnect; a renewal the provider didn't answer, a failure.
    if (connectErrors.codeOf(error) === "connect.connection_inactive") {
      throw placeErrors.create("place.inactive");
    }
    if (connectionErrors.codeOf(error) !== undefined) {
      throw placeErrors.create("place.provider_failed");
    }
    throw error;
  }
  return {
    provider: provider.data,
    tenant: connection.tenant,
    access: { token, budget: requestBudget(requests) },
  };
};

/** The provider's refusal or failure, as the place's error. */
const readFailure = (error: unknown): unknown => {
  if (error instanceof z.ZodError || error instanceof TypeError) {
    return placeErrors.create("place.provider_failed");
  }
  if (!(error instanceof SourceError)) {
    return error;
  }
  const { status, retryAfterMs } = error;
  if (status === 429 || status === 503) {
    return placeErrors.create(
      "place.throttled",
      retryAfterMs === undefined ? undefined : { retryAfterMs }
    );
  }
  if (status === 401) {
    return placeErrors.create("place.inactive");
  }
  // Gone, or not the admin's to open.
  if (status === 403 || status === 404) {
    return placeErrors.create("place.no_item");
  }
  return placeErrors.create("place.provider_failed");
};

/** Runs a read, with the provider's failures as the place's errors. */
const reading = async <T>(read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    throw readFailure(error);
  }
};

/** The places a documents connection reaches. */
export const readPlaces = async (
  env: Env,
  request: unknown
): Promise<PlacesRead> => {
  const { connectionId } = placeErrors.parse(
    "place.not_found",
    placesReadRequestSchema,
    request
  );
  const { provider, tenant, access } = await accessOf(env, connectionId, 1);
  const places = await reading(
    async () =>
      await (provider === "microsoft-documents"
        ? graphPlaces(access)
        : googlePlaces(access))
  );
  return { tenant, places };
};

/** One page of a folder of a place, or of a search of it, from `cursor` on. */
export const readPlaceItems = async (
  env: Env,
  request: unknown
): Promise<PlaceItemsRead> => {
  const { connectionId, ...asked } = placeErrors.parse(
    "place.invalid",
    placeItemsRequestSchema,
    request
  );
  const { provider, tenant, access } = await accessOf(env, connectionId, 1);
  if (
    !isPlace(provider, asked.place) ||
    (asked.folder !== null && !isItem(provider, asked.folder))
  ) {
    throw placeErrors.create("place.no_item");
  }
  const { items, next, read } = await reading(
    async () =>
      await (provider === "microsoft-documents"
        ? graphItems(access, asked)
        : googleItems(access, asked))
  );
  // A page past what was asked, or a position too long to hand back, is
  // never passed on, nor taken for the end.
  if (
    read > placesLimits.itemsPerRead ||
    (next !== null && next.length > placesLimits.cursorLength)
  ) {
    throw placeErrors.create("place.provider_failed");
  }
  return { tenant, items, next };
};

/** Fetches a file the admin picked in a place, for core to read. */
export const readPlaceFile = async (
  env: Env,
  request: unknown
): Promise<PlaceFile> => {
  const { connectionId, place, item } = placeErrors.parse(
    "place.invalid",
    placeFileRequestSchema,
    request
  );
  const { provider, tenant, access } = await accessOf(env, connectionId, 2);
  if (!isPlace(provider, place) || !isItem(provider, item)) {
    throw placeErrors.create("place.no_item");
  }
  const file = await reading(
    async () =>
      await (provider === "microsoft-documents"
        ? graphFile(access, place, item)
        : googleFile(access, place, item))
  );
  return { tenant, ...file };
};
