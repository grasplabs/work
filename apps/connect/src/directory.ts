import { connectErrors, connectionErrors } from "@grasp-os/shared/connect";
import {
  directoryErrors,
  directoryLimits,
  directoryLookupRequestSchema,
  directoryProviderSchema,
  directoryReadRequestSchema,
} from "@grasp-os/shared/directory";
import type {
  DirectoryConnection,
  DirectoryDeletedRead,
  DirectoryLookup,
  DirectoryPerson,
  DirectoryProvider,
  DirectoryRead,
} from "@grasp-os/shared/directory";
import { and, eq, inArray, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { connections } from "./db/schema.ts";
import {
  SourceError,
  answerMaxBytes,
  bytesFromProvider,
  readFromProvider,
  requestBudget,
} from "./event-kinds.ts";
import type { ProviderAccess } from "./event-kinds.ts";
import { accessTokenFor } from "./tokens.ts";

// The directory's reads (GRA-369): who works where, from Microsoft Graph
// or Google's directory, with the directory connection's token, which
// stays here. Core asks for one page at a time, for the onboarding, and
// the admin's browser makes a roster of what it answers. Threat model,
// before code:
//
// - A token reaching more than the directory: its connection has an app
//   of its own at the provider and is kept only with exactly its read
//   scope (oauth.ts, `grantedAsAsked`), so it can't read mail, calendars
//   or files; it takes no connector calls (call.ts, no connector can
//   name its provider); and nothing but the provider's users endpoint is
//   sent it, or its deleted users. A cursor is only ever read for its
//   position: the request is built here, on the endpoint the read asks,
//   every time.
// - Personal data past what a roster needs: only names, email addresses,
//   departments, jobs and managers are asked for (`$select`, `fields`)
//   and answered. Nothing of sign-ins, phones, addresses or groups. Of
//   an account that is turned off, only its ID is answered, apart from
//   the people, for core's daily read to tell a leaver (GRA-2056); of a
//   deleted one, only its ID too, from Entra's deleted users.
// - Planted text: anyone with a directory account can name themselves
//   anything. Names, departments and jobs are cut to what a roster keeps,
//   without control or format characters, and are only data. IDs that
//   aren't the provider's are left out; an address that isn't one is
//   none.
// - Another tenant's data: only a directory connection is read, and each
//   read says its tenant, which core checks against its own.
// - A flood: one read asks for `peoplePerRead` people and sends one
//   request; a page holding more than it asked for is refused; core
//   bounds the reads of a directory.
// - A lookup that reads someone else: core looks one person up by the ID
//   their chat platform verified (Teams' `aadObjectId`), never by name or
//   email. The ID must be the provider's own shape before it is put in
//   the path, so it can't name another endpoint, and the person answered
//   must carry that same ID.

const graphHost = "graph.microsoft.com";
const graphUsersPath = "/v1.0/users";
const graphDeletedUsersPath =
  "/v1.0/directory/deletedItems/microsoft.graph.user";
const googleHost = "admin.googleapis.com";
const googleUsersPath = "/admin/directory/v1/users";

/** Each provider's API, sent the token: only on its own host, over HTTPS. */
const graphSpec = { name: "Microsoft Graph", hosts: [graphHost] };
const graph = readFromProvider(graphSpec);
/** Graph's answer as it came: its deleted users are parsed apart from the fetch (`deletedPageOf`). */
const graphBytes = bytesFromProvider(graphSpec);
const googleSpec = { name: "Google's directory", hosts: [googleHost] };
const googleDirectory = readFromProvider(googleSpec);
/** Google's answer as it came: its deleted users are parsed apart from the fetch (`deletedLists`). */
const googleBytes = bytesFromProvider(googleSpec);

/** IDs as Entra issues them. */
const guidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** IDs as Google's directory issues them. */
const googleIdPattern = /^\d{1,32}$/u;

const graphUserSchema = z.object({
  id: z.string(),
  displayName: z.string().nullish(),
  mail: z.string().nullish(),
  department: z.string().nullish(),
  jobTitle: z.string().nullish(),
  accountEnabled: z.boolean().nullish(),
  userType: z.string().nullish(),
  manager: z.object({ id: z.string() }).nullish(),
});

const graphPageSchema = z.object({
  value: z.array(graphUserSchema),
  "@odata.nextLink": z.string().optional(),
});

const graphDeletedPageSchema = z.object({
  value: z.array(z.object({ id: z.string(), userType: z.string().nullish() })),
  "@odata.nextLink": z.string().optional(),
});

const googleUserSchema = z.object({
  id: z.string(),
  primaryEmail: z.string().nullish(),
  name: z.object({ fullName: z.string().nullish() }).nullish(),
  suspended: z.boolean().nullish(),
  archived: z.boolean().nullish(),
  organizations: z
    .array(
      z.object({
        department: z.string().nullish(),
        title: z.string().nullish(),
        primary: z.boolean().nullish(),
      })
    )
    .nullish(),
  relations: z
    .array(
      z.object({ type: z.string().nullish(), value: z.string().nullish() })
    )
    .nullish(),
});

const googlePageSchema = z.object({
  users: z.array(googleUserSchema).nullish(),
  nextPageToken: z.string().nullish(),
});

/**
 * Control and format characters, bidirectional overrides among them: what
 * could make a planted name show as something else.
 */
const invisible = /[\p{Cc}\p{Cf}]/gu;
const spaces = /\s+/gu;

/** Text as kept: without control or format characters, on one line, trimmed and cut. */
export const textOf = (text: string | null | undefined): string =>
  (text ?? "")
    .replaceAll(spaces, " ")
    .replaceAll(invisible, "")
    .trim()
    .slice(0, directoryLimits.textLength)
    .trim();

const emailSchema = z.email().max(directoryLimits.emailLength);

/** An email address as kept, lower case; empty when it isn't one. */
export const emailOf = (email: string | null | undefined): string => {
  const lower = (email ?? "").trim().toLowerCase();
  return emailSchema.safeParse(lower).success ? lower : "";
};

/** The users endpoint, as a read asks it, the same every time. */
const graphUsers = (): URL => {
  const url = new URL(`https://${graphHost}${graphUsersPath}`);
  url.searchParams.set(
    "$select",
    "id,displayName,mail,department,jobTitle,accountEnabled,userType"
  );
  url.searchParams.set("$expand", "manager($select=id)");
  url.searchParams.set("$top", String(directoryLimits.peoplePerRead));
  return url;
};

/** Entra's deleted users, as a read asks for them: their IDs, and whether each was a guest. */
const graphDeletedUsers = (): URL => {
  const url = new URL(`https://${graphHost}${graphDeletedUsersPath}`);
  url.searchParams.set("$select", "id,userType");
  url.searchParams.set("$top", String(directoryLimits.peoplePerRead));
  return url;
};

/**
 * Google's deleted users, as a read asks for them: those deleted in the
 * last 20 days (the Admin SDK's users guide), their IDs alone.
 */
const googleDeletedUsers = (): URL => {
  const url = new URL(`https://${googleHost}${googleUsersPath}`);
  url.searchParams.set("customer", "my_customer");
  url.searchParams.set("maxResults", String(directoryLimits.peoplePerRead));
  url.searchParams.set("showDeleted", "true");
  url.searchParams.set("fields", "nextPageToken,users(id)");
  return url;
};

const googleUsers = (): URL => {
  const url = new URL(`https://${googleHost}${googleUsersPath}`);
  url.searchParams.set("customer", "my_customer");
  url.searchParams.set("maxResults", String(directoryLimits.peoplePerRead));
  url.searchParams.set("projection", "basic");
  url.searchParams.set("viewType", "admin_view");
  url.searchParams.set(
    "fields",
    "nextPageToken,users(id,primaryEmail,name/fullName,suspended,archived,organizations(department,title,primary),relations(type,value))"
  );
  return url;
};

/** How each provider says where in its users a page starts. */
const positions: Record<DirectoryProvider, string> = {
  "microsoft-directory": "$skiptoken",
  "google-directory": "pageToken",
};

/** Each provider's users endpoint, as a read asks it. */
const usersOf: Record<DirectoryProvider, () => URL> = {
  "microsoft-directory": graphUsers,
  "google-directory": googleUsers,
};

/**
 * The request a read sends: `url`, at the position `cursor` names
 * under `position`, if any. Only that is taken from a cursor; a cursor
 * that isn't a link to that same endpoint, or holds no position, is
 * refused before anything is sent.
 */
const linkedRequest = (
  url: URL,
  position: string,
  cursor: string | null
): URL => {
  if (cursor === null) {
    return url;
  }
  let link: URL;
  try {
    link = new URL(cursor);
  } catch {
    throw directoryErrors.create("directory.cursor_invalid");
  }
  const at = link.searchParams.get(position);
  if (
    link.protocol !== "https:" ||
    link.host !== url.host ||
    link.pathname !== url.pathname ||
    link.username !== "" ||
    link.password !== "" ||
    at === null ||
    at === ""
  ) {
    throw directoryErrors.create("directory.cursor_invalid");
  }
  url.searchParams.set(position, at);
  return url;
};

/** The request a read of `provider`'s users sends, at `cursor`. */
const requestOf = (provider: DirectoryProvider, cursor: string | null): URL =>
  linkedRequest(usersOf[provider](), positions[provider], cursor);

/** The request a read of Entra's deleted users sends, at `cursor`. */
const graphDeletedRequestOf = (cursor: string | null): URL =>
  linkedRequest(graphDeletedUsers(), "$skiptoken", cursor);

/** The request a read of Google's deleted users sends, at `cursor`. */
const googleDeletedRequestOf = (cursor: string | null): URL =>
  linkedRequest(googleDeletedUsers(), "pageToken", cursor);

/**
 * The Entra object ID of `user` when it is one of the tenant's own
 * accounts, turned off (`accountEnabled: false`); none otherwise.
 */
const graphDisabled = (user: z.output<typeof graphUserSchema>): string[] =>
  guidPattern.test(user.id) &&
  user.accountEnabled === false &&
  user.userType?.toLowerCase() !== "guest"
    ? [user.id.toLowerCase()]
    : [];

/**
 * Someone in Entra, as kept; none for a guest or a disabled account. Who
 * is listed is decided by the ID and whether the account is on, never by
 * a name: one without a name is answered with an empty one, and a roster
 * leaves it out itself.
 */
const graphPerson = (
  user: z.output<typeof graphUserSchema>
): DirectoryPerson | null => {
  if (
    !guidPattern.test(user.id) ||
    user.accountEnabled === false ||
    user.userType?.toLowerCase() === "guest"
  ) {
    return null;
  }
  const name = textOf(user.displayName);
  const manager = user.manager?.id ?? "";
  return {
    id: user.id.toLowerCase(),
    name,
    email: emailOf(user.mail),
    department: textOf(user.department),
    title: textOf(user.jobTitle),
    manager: guidPattern.test(manager) ? manager.toLowerCase() : null,
  };
};

/** The Google user ID of `user` when its account is suspended or archived; none otherwise. */
const googleDisabled = (user: z.output<typeof googleUserSchema>): string[] =>
  googleIdPattern.test(user.id) &&
  (user.suspended === true || user.archived === true)
    ? [user.id]
    : [];

/**
 * Someone in Google's directory, as kept; none for a suspended or archived
 * account. One without a name is answered with an empty one, as Entra's.
 */
const googlePerson = (
  user: z.output<typeof googleUserSchema>
): DirectoryPerson | null => {
  if (
    !googleIdPattern.test(user.id) ||
    user.suspended === true ||
    user.archived === true
  ) {
    return null;
  }
  const name = textOf(user.name?.fullName);
  const organizations = user.organizations ?? [];
  const organization =
    organizations.find(({ primary }) => primary === true) ?? organizations[0];
  const manager = (user.relations ?? []).find(
    ({ type }) => type === "manager"
  )?.value;
  const managerEmail = emailOf(manager);
  return {
    id: user.id,
    name,
    email: emailOf(user.primaryEmail),
    department: textOf(organization?.department),
    title: textOf(organization?.title),
    manager: managerEmail === "" ? null : managerEmail,
  };
};

/** The user endpoint of the one person with `id`, as a lookup asks it; none for an ID that isn't the provider's. */
const personUrlOf = (provider: DirectoryProvider, id: string): URL | null => {
  if (provider === "microsoft-directory") {
    if (!guidPattern.test(id)) {
      return null;
    }
    const url = new URL(
      `https://${graphHost}${graphUsersPath}/${id.toLowerCase()}`
    );
    url.searchParams.set(
      "$select",
      "id,displayName,mail,department,jobTitle,accountEnabled,userType"
    );
    url.searchParams.set("$expand", "manager($select=id)");
    return url;
  }
  if (!googleIdPattern.test(id)) {
    return null;
  }
  const url = new URL(`https://${googleHost}${googleUsersPath}/${id}`);
  url.searchParams.set("projection", "basic");
  url.searchParams.set("viewType", "admin_view");
  url.searchParams.set(
    "fields",
    "id,primaryEmail,name/fullName,suspended,archived,organizations(department,title,primary),relations(type,value)"
  );
  return url;
};

/** The one person a lookup's answer holds, as a read would answer them. */
const personOf = async (
  provider: DirectoryProvider,
  access: ProviderAccess,
  url: URL
): Promise<DirectoryPerson | null> =>
  provider === "microsoft-directory"
    ? graphPerson(graphUserSchema.parse(await graph(access, url.href)))
    : googlePerson(
        googleUserSchema.parse(await googleDirectory(access, url.href))
      );

/**
 * One page of the provider's users: its people, the IDs of its accounts
 * that are turned off, and the link to the next.
 */
const pageOf = async (
  provider: DirectoryProvider,
  access: ProviderAccess,
  url: URL
): Promise<{
  people: DirectoryPerson[];
  disabled: string[];
  next: string | null;
  read: number;
}> => {
  if (provider === "microsoft-directory") {
    const page = graphPageSchema.parse(await graph(access, url.href));
    return {
      people: page.value.flatMap((user) => graphPerson(user) ?? []),
      disabled: page.value.flatMap(graphDisabled),
      next: page["@odata.nextLink"] ?? null,
      read: page.value.length,
    };
  }
  const page = googlePageSchema.parse(await googleDirectory(access, url.href));
  const users = page.users ?? [];
  const token = page.nextPageToken ?? "";
  const next = googleUsers();
  next.searchParams.set("pageToken", token);
  return {
    people: users.flatMap((user) => googlePerson(user) ?? []),
    disabled: users.flatMap(googleDisabled),
    next: token === "" ? null : next.href,
    read: users.length,
  };
};

/** The directory's connections still connected, for core. */
export const directoryConnections = async (
  env: Env
): Promise<DirectoryConnection[]> => {
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
        inArray(connections.provider, directoryProviderSchema.options),
        ne(connections.status, "disconnected")
      )
    );
  return rows.flatMap(({ id, provider, tenant, status, createdAt }) => {
    const known = directoryProviderSchema.safeParse(provider);
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
 * The connection's access token, renewed if it must be: a grant that ran
 * out, or a renewal granted other access, is `directory.inactive`, for an
 * admin to reconnect; a renewal the provider didn't answer is
 * `directory.provider_failed`.
 */
const directoryToken = async (
  env: Env,
  connectionId: string
): Promise<string> => {
  try {
    return await accessTokenFor(env, connectionId);
  } catch (error) {
    if (connectErrors.codeOf(error) === "connect.connection_inactive") {
      throw directoryErrors.create("directory.inactive");
    }
    if (connectionErrors.codeOf(error) !== undefined) {
      throw directoryErrors.create("directory.provider_failed");
    }
    throw error;
  }
};

/** The provider's refusal or failure, as the directory's error. */
const readFailure = (error: unknown, provider: DirectoryProvider): unknown => {
  if (error instanceof z.ZodError) {
    return directoryErrors.create("directory.provider_failed");
  }
  if (!(error instanceof SourceError)) {
    return error;
  }
  const { status, retryAfterMs } = error;
  if (status === 429 || status === 503) {
    return directoryErrors.create(
      "directory.throttled",
      retryAfterMs === undefined ? undefined : { retryAfterMs }
    );
  }
  // Google's directory refuses a token of someone who isn't its admin
  // (403): no reconnect by them mends it, so it says who must connect it.
  if (status === 403 && provider === "google-directory") {
    return directoryErrors.create("directory.not_admin");
  }
  if (status === 401 || status === 403) {
    return directoryErrors.create("directory.inactive");
  }
  return directoryErrors.create("directory.provider_failed");
};

/** A page of a directory's deleted accounts: their IDs, and the link to the next. */
interface DeletedPage {
  ids: string[];
  next: string | null;
}

const googleDeletedPageSchema = z.object({
  users: z.array(z.object({ id: z.string() })).nullish(),
  nextPageToken: z.string().nullish(),
});

/**
 * Each provider's deleted users: the request a read sends at a cursor, its
 * answer's bytes as they came, and the page they hold, or null when the
 * answer, though it came, isn't such a page (empty, not JSON, or JSON of
 * another shape): told apart by what failed, here, from a fetch that
 * failed (`deletedReadFailure`).
 */
const deletedLists: Record<
  DirectoryProvider,
  {
    request: (cursor: string | null) => URL;
    bytes: (access: ProviderAccess, url: string) => Promise<Uint8Array>;
    pageOf: (json: unknown) => DeletedPage | null;
  }
> = {
  "microsoft-directory": {
    request: graphDeletedRequestOf,
    bytes: async (access, url) => await graphBytes(access, url, answerMaxBytes),
    pageOf: (json) => {
      const page = graphDeletedPageSchema.safeParse(json);
      return page.success
        ? {
            // Guests aside, and IDs that aren't Entra's.
            ids: page.data.value.flatMap(({ id, userType }) =>
              guidPattern.test(id) && userType?.toLowerCase() !== "guest"
                ? [id.toLowerCase()]
                : []
            ),
            next: page.data["@odata.nextLink"] ?? null,
          }
        : null;
    },
  },
  "google-directory": {
    request: googleDeletedRequestOf,
    bytes: async (access, url) =>
      await googleBytes(access, url, answerMaxBytes),
    pageOf: (json) => {
      const page = googleDeletedPageSchema.safeParse(json);
      if (!page.success) {
        return null;
      }
      const token = page.data.nextPageToken ?? "";
      const next = googleDeletedUsers();
      next.searchParams.set("pageToken", token);
      return {
        // IDs that aren't Google's aside.
        ids: (page.data.users ?? []).flatMap(({ id }) =>
          googleIdPattern.test(id) ? [id] : []
        ),
        next: token === "" ? null : next.href,
      };
    },
  },
};

/** The JSON `bytes` hold, or nothing when they hold none. */
const jsonIn = (bytes: Uint8Array): { json: unknown } | undefined => {
  try {
    return { json: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return undefined;
  }
};

/**
 * Why a directory's deleted users couldn't be fetched, as the directory's
 * error. The line core goes by (directory-people.ts `deletedOf`): a
 * refusal of the list itself, or an endpoint that isn't one, is its
 * permission or the endpoint, not the moment, and doesn't pass by
 * retrying in a quarter hour: `directory.deleted_refused` (401 or 403 on
 * this call: its permission, `User.Read.All` without an Entra role, is
 * still unproved on a real tenant) and `directory.deleted_unsupported`
 * (400 or 404; an answer that came but isn't a list is the same,
 * `deletedLists`). Anything else, throttling, server errors and a fetch
 * that never got an answer among it, is the moment: the read's own
 * failures (`readFailure`).
 */
const deletedReadFailure = (
  error: unknown,
  provider: DirectoryProvider
): unknown => {
  if (error instanceof SourceError) {
    if (error.status === 401 || error.status === 403) {
      return directoryErrors.create("directory.deleted_refused");
    }
    if (error.status === 400 || error.status === 404) {
      return directoryErrors.create("directory.deleted_unsupported");
    }
  }
  return readFailure(error, provider);
};

/** Whether `cursor` is a link `request` would go on from. */
const isCursorFor = (
  request: (cursor: string) => URL,
  cursor: string
): boolean => {
  if (cursor.length > directoryLimits.cursorLength) {
    return false;
  }
  try {
    request(cursor);
    return true;
  } catch {
    return false;
  }
};

/** Whether `cursor` is a link a read of `provider` would go on from. */
const isCursorOf = (provider: DirectoryProvider, cursor: string): boolean =>
  isCursorFor((at) => requestOf(provider, at), cursor);

/**
 * The directory connection a read names, active, its provider, and the
 * read's position; `directory.not_found` or `directory.inactive` otherwise.
 */
const connectionToRead = async (env: Env, request: unknown) => {
  const { connectionId, cursor } = directoryErrors.parse(
    "directory.not_found",
    directoryReadRequestSchema,
    request
  );
  const connection = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  const provider = directoryProviderSchema.safeParse(connection?.provider);
  if (
    connection === undefined ||
    !provider.success ||
    connection.tenant === null
  ) {
    throw directoryErrors.create("directory.not_found");
  }
  if (connection.status !== "active") {
    throw directoryErrors.create("directory.inactive");
  }
  return {
    connectionId: connection.id,
    tenant: connection.tenant,
    provider: provider.data,
    cursor,
  };
};

/** Reads one page of a directory connection's people, from `cursor` on. */
export const readDirectory = async (
  env: Env,
  request: unknown
): Promise<DirectoryRead> => {
  const connection = await connectionToRead(env, request);
  const url = requestOf(connection.provider, connection.cursor);
  const access: ProviderAccess = {
    token: await directoryToken(env, connection.connectionId),
    budget: requestBudget(1),
  };
  let page: Awaited<ReturnType<typeof pageOf>>;
  try {
    page = await pageOf(connection.provider, access, url);
  } catch (error) {
    throw readFailure(error, connection.provider);
  }
  const { people, disabled, next, read } = page;
  // A next link elsewhere, or a page past what was asked, is never kept,
  // nor taken for the end.
  if (
    (next !== null && !isCursorOf(connection.provider, next)) ||
    read > directoryLimits.peoplePerRead
  ) {
    throw directoryErrors.create("directory.provider_failed");
  }
  return { tenant: connection.tenant, people, disabled, next };
};

/**
 * Reads one page of a directory connection's deleted users, from `cursor`
 * on: the proof that someone no longer listed has left. Entra keeps a
 * deleted account 30 days, Google 20.
 */
export const readDeletedDirectoryUsers = async (
  env: Env,
  request: unknown
): Promise<DirectoryDeletedRead> => {
  const connection = await connectionToRead(env, request);
  const list = deletedLists[connection.provider];
  const url = list.request(connection.cursor);
  const access: ProviderAccess = {
    token: await directoryToken(env, connection.connectionId),
    budget: requestBudget(1),
  };
  let bytes: Uint8Array;
  try {
    bytes = await list.bytes(access, url.href);
  } catch (error) {
    throw deletedReadFailure(error, connection.provider);
  }
  const answered = jsonIn(bytes);
  const page = answered === undefined ? null : list.pageOf(answered.json);
  if (page === null) {
    throw directoryErrors.create("directory.deleted_unsupported");
  }
  // A next link elsewhere is never kept, nor taken for the end. Its size
  // is bounded where it is kept: core takes the whole read as one value.
  if (page.next !== null && !isCursorFor(list.request, page.next)) {
    throw directoryErrors.create("directory.provider_failed");
  }
  return { tenant: connection.tenant, deleted: page.ids, next: page.next };
};

/**
 * Looks up one person in a directory connection by their ID at the
 * provider: null when it holds nobody by that ID (the provider answers
 * 404), or only a guest or an account that is turned off.
 */
export const lookUpInDirectory = async (
  env: Env,
  request: unknown
): Promise<DirectoryLookup> => {
  const { connectionId, id } = directoryErrors.parse(
    "directory.not_found",
    directoryLookupRequestSchema,
    request
  );
  const connection = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  const provider = directoryProviderSchema.safeParse(connection?.provider);
  if (
    connection === undefined ||
    !provider.success ||
    connection.tenant === null
  ) {
    throw directoryErrors.create("directory.not_found");
  }
  if (connection.status !== "active") {
    throw directoryErrors.create("directory.inactive");
  }
  const url = personUrlOf(provider.data, id);
  if (url === null) {
    return { tenant: connection.tenant, person: null };
  }
  const access: ProviderAccess = {
    token: await directoryToken(env, connection.id),
    budget: requestBudget(1),
  };
  let person: DirectoryPerson | null;
  try {
    person = await personOf(provider.data, access, url);
  } catch (error) {
    if (error instanceof SourceError && error.status === 404) {
      return { tenant: connection.tenant, person: null };
    }
    throw readFailure(error, provider.data);
  }
  // Someone else answered for the ID asked: nobody is taken for them; nor
  // is an account with no name made anyone (channels/door.ts makes a
  // member of whom this answers).
  const asked = provider.data === "microsoft-directory" ? id.toLowerCase() : id;
  return {
    tenant: connection.tenant,
    person: person?.id === asked && person.name !== "" ? person : null,
  };
};
