import { connectErrors, connectionErrors } from "@grasp-os/shared/connect";
import {
  directoryErrors,
  directoryLimits,
  directoryProviderSchema,
  directoryReadRequestSchema,
} from "@grasp-os/shared/directory";
import type {
  DirectoryConnection,
  DirectoryPerson,
  DirectoryProvider,
  DirectoryRead,
} from "@grasp-os/shared/directory";
import { and, eq, inArray, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { connections } from "./db/schema.ts";
import { SourceError, readFromProvider, requestBudget } from "./event-kinds.ts";
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
//   sent it. A cursor is only ever read for its position: the request is
//   built here, on the users endpoint, every time.
// - Personal data past what a roster needs: only names, email addresses,
//   departments, jobs and managers are asked for (`$select`, `fields`)
//   and answered. Nothing of sign-ins, phones, addresses or groups.
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

const graphHost = "graph.microsoft.com";
const graphUsersPath = "/v1.0/users";
const googleHost = "admin.googleapis.com";
const googleUsersPath = "/admin/directory/v1/users";

/** Each provider's API, sent the token: only on its own host, over HTTPS. */
const graph = readFromProvider({ name: "Microsoft Graph", hosts: [graphHost] });
const googleDirectory = readFromProvider({
  name: "Google's directory",
  hosts: [googleHost],
});

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
 * The request a read sends: the provider's users endpoint, at the
 * position `cursor` names, if any. Only that is taken from a cursor; a
 * cursor that isn't a link to the provider's users, or holds no position,
 * is refused before anything is sent.
 */
const requestOf = (provider: DirectoryProvider, cursor: string | null): URL => {
  const url = usersOf[provider]();
  if (cursor === null) {
    return url;
  }
  let link: URL;
  try {
    link = new URL(cursor);
  } catch {
    throw directoryErrors.create("directory.cursor_invalid");
  }
  const position = link.searchParams.get(positions[provider]);
  if (
    link.protocol !== "https:" ||
    link.host !== url.host ||
    link.pathname !== url.pathname ||
    link.username !== "" ||
    link.password !== "" ||
    position === null ||
    position === ""
  ) {
    throw directoryErrors.create("directory.cursor_invalid");
  }
  url.searchParams.set(positions[provider], position);
  return url;
};

/** Someone in Entra, as kept; none for a guest, a disabled account, or no name. */
const graphPerson = (
  user: z.output<typeof graphUserSchema>
): DirectoryPerson | null => {
  const name = textOf(user.displayName);
  if (
    !guidPattern.test(user.id) ||
    user.accountEnabled === false ||
    user.userType?.toLowerCase() === "guest" ||
    name === ""
  ) {
    return null;
  }
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

/** Someone in Google's directory, as kept; none for a suspended or archived account, or no name. */
const googlePerson = (
  user: z.output<typeof googleUserSchema>
): DirectoryPerson | null => {
  const name = textOf(user.name?.fullName);
  if (
    !googleIdPattern.test(user.id) ||
    user.suspended === true ||
    user.archived === true ||
    name === ""
  ) {
    return null;
  }
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

/** One page of the provider's users: its people, and the link to the next. */
const pageOf = async (
  provider: DirectoryProvider,
  access: ProviderAccess,
  url: URL
): Promise<{
  people: DirectoryPerson[];
  next: string | null;
  read: number;
}> => {
  if (provider === "microsoft-directory") {
    const page = graphPageSchema.parse(await graph(access, url.href));
    return {
      people: page.value.flatMap((user) => graphPerson(user) ?? []),
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
const readFailure = (error: unknown): unknown => {
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
  // Google's directory refuses a token of someone who isn't its admin:
  // it needs an admin's account connected.
  if (status === 401 || status === 403) {
    return directoryErrors.create("directory.inactive");
  }
  return directoryErrors.create("directory.provider_failed");
};

/** Whether `cursor` is a link a read of `provider` would go on from. */
const isCursorOf = (provider: DirectoryProvider, cursor: string): boolean => {
  if (cursor.length > directoryLimits.cursorLength) {
    return false;
  }
  try {
    requestOf(provider, cursor);
    return true;
  } catch {
    return false;
  }
};

/** Reads one page of a directory connection's people, from `cursor` on. */
export const readDirectory = async (
  env: Env,
  request: unknown
): Promise<DirectoryRead> => {
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
  const url = requestOf(provider.data, cursor);
  const access: ProviderAccess = {
    token: await directoryToken(env, connection.id),
    budget: requestBudget(1),
  };
  let page: Awaited<ReturnType<typeof pageOf>>;
  try {
    page = await pageOf(provider.data, access, url);
  } catch (error) {
    throw readFailure(error);
  }
  const { people, next, read } = page;
  // A next link elsewhere, or a page past what was asked, is never kept,
  // nor taken for the end.
  if (
    (next !== null && !isCursorOf(provider.data, next)) ||
    read > directoryLimits.peoplePerRead
  ) {
    throw directoryErrors.create("directory.provider_failed");
  }
  return { tenant: connection.tenant, people, next };
};
