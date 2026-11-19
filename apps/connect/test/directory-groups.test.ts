import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { directoryErrors } from "@grasp-os/shared/directory";
import type {
  DirectoryGroup,
  DirectoryGroupRead,
} from "@grasp-os/shared/directory";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { connectionTokens } from "../src/db/schema.ts";
import { connectAccount, outcome, ownAccount, someone } from "./connect.ts";
import { fakeInternet } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";
import { acmeDomain, acmeTenant, clients } from "./provider-config.ts";

// The directory's groups (GRA-2056, G1): an admin searches them to map one
// to a team, and the daily read reads a mapped group's members. The ways
// it could go wrong come first: a connection without the groups' grant,
// a fact Microsoft didn't answer taken as fine, a search text that
// rewrites the filter, a next link that sends the token elsewhere, a
// partial member list taken for the whole, a group gone mid-read, a
// group ID that names another endpoint, a Google connection read as
// Entra's.

const providers = fakeProviders();

/** What the fake Graph holds, for each test to set. */
interface Graph {
  groups: Record<string, unknown>[];
  /** Each group's members, nested groups' included, as Graph lists them. */
  members: Record<string, Record<string, unknown>[] | undefined>;
  /** Members per page. */
  pageSize: number;
  /** The next link each members page hands back, instead of its own. */
  nextLink?: string;
  /** Answers every groups call instead, when set. */
  answer?: () => Response;
}

const graph: Graph = { groups: [], members: {}, pageSize: 100 };

const groupsPath = "/v1.0/groups";
const startsWith = /^startswith\(displayName,'(?<text>.*)'\)$/u;

/** Graph's groups whose name starts with the filter's text, `$top` of them. */
const searched = (url: URL): Response => {
  const text = startsWith
    .exec(url.searchParams.get("$filter") ?? "")
    ?.groups?.text?.replaceAll("''", "'");
  if (text === undefined) {
    return Response.json({ error: { code: "BadRequest" } }, { status: 400 });
  }
  const found = graph.groups.filter(
    (group) =>
      typeof group.displayName === "string" &&
      group.displayName.startsWith(text)
  );
  const top = Number(url.searchParams.get("$top") ?? "100");
  return Response.json({
    value: found.slice(0, top),
    ...(found.length > top
      ? {
          "@odata.nextLink": `https://graph.microsoft.com${groupsPath}?$skiptoken=x`,
        }
      : {}),
  });
};

const membersPath = /^\/v1\.0\/groups\/(?<id>[^/]+)\/transitiveMembers$/u;
const groupPath = /^\/v1\.0\/groups\/(?<id>[^/]+)$/u;

const notFound = () =>
  Response.json(
    { error: { code: "Request_ResourceNotFound" } },
    { status: 404 }
  );

/** A page of a group's members, from `$skiptoken`. */
const membersPage = (id: string, url: URL): Response => {
  const members = graph.members[id];
  if (members === undefined) {
    return notFound();
  }
  const from = Number(url.searchParams.get("$skiptoken") ?? "0");
  const end = from + graph.pageSize;
  return Response.json({
    value: members.slice(from, end),
    ...(end < members.length
      ? {
          "@odata.nextLink":
            graph.nextLink ??
            `https://graph.microsoft.com/v1.0/groups/${id}/transitiveMembers?$skiptoken=${end}`,
        }
      : {}),
  });
};

const { sent } = fakeInternet((_request, url) => {
  if (url.hostname !== "graph.microsoft.com") {
    return notFound();
  }
  if (graph.answer !== undefined) {
    return graph.answer();
  }
  if (url.pathname === groupsPath) {
    return searched(url);
  }
  // The people read: nobody, which is all a groups test needs of it.
  if (url.pathname === "/v1.0/users") {
    return Response.json({ value: [] });
  }
  const members = membersPath.exec(url.pathname)?.groups?.id;
  if (members !== undefined) {
    return membersPage(members, url);
  }
  const one = groupPath.exec(url.pathname)?.groups?.id;
  const group = graph.groups.find(({ id }) => id === one);
  return group === undefined ? notFound() : Response.json(group);
});

/** What the directory's app asks for, as Entra answers it, the groups' scope among it. */
const asAsked =
  "openid profile email https://graph.microsoft.com/User.Read https://graph.microsoft.com/User.Read.All https://graph.microsoft.com/Group.ReadBasic.All";
/** What it asked for before groups: a connection made then. */
const beforeGroups =
  "openid profile email https://graph.microsoft.com/User.Read https://graph.microsoft.com/User.Read.All";

const connectDirectory = async (
  admin: ConnectionPerson = someone("admin"),
  granted = asAsked,
  provider: "microsoft-directory" | "google-directory" = "microsoft-directory"
): Promise<string> =>
  await connectAccount(
    providers,
    admin,
    {
      ...ownAccount(
        admin,
        provider === "microsoft-directory" ? "microsoft" : "google"
      ),
      audience:
        provider === "microsoft-directory"
          ? clients.microsoftDirectory.id
          : clients.googleDirectory.id,
      granted,
    },
    {
      provider,
      scope: "shared",
      tenant: provider === "microsoft-directory" ? acmeTenant : acmeDomain,
    }
  );

const readPeople = async (connectionId: string) =>
  await exports.default.readDirectory({ connectionId, cursor: null });

const search = async (connectionId: string, query: string) =>
  await exports.default.searchDirectoryGroups({ connectionId, query });

const readGroup = async (
  connectionId: string,
  groupId: string,
  cursor: string | null = null
) =>
  await exports.default.readDirectoryGroup({ connectionId, groupId, cursor });

/** Every page of a group, as core reads it: on until there is no next link. */
const readWhole = async (connectionId: string, groupId: string) => {
  const pages: DirectoryGroupRead[] = [];
  let cursor: string | null = null;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page goes on from the last
    const page: DirectoryGroupRead = await readGroup(
      connectionId,
      groupId,
      cursor
    );
    pages.push(page);
    cursor = page.next;
  } while (cursor !== null);
  return pages;
};

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return directoryErrors.codeOf(error) ?? (await outcome(promise));
  }
};

const guid = (): string => crypto.randomUUID();

/** Keeps `connectionId` as a connection made before groups were asked for, its token run out or not. */
const madeBeforeGroups = async (
  connectionId: string,
  { expired }: { expired: boolean }
): Promise<void> => {
  await drizzle(env.DB)
    .update(connectionTokens)
    .set({
      grantedScopes: beforeGroups,
      ...(expired ? { accessExpiresAt: new Date(0) } : {}),
    })
    .where(eq(connectionTokens.connectionId, connectionId));
};

/** The `scope` each renewal this test sent asked for; null for one that named none. */
const renewalsAsked = (): (string | null)[] =>
  providers.state.requests
    .filter(({ form }) => form.get("grant_type") === "refresh_token")
    .map(({ form }) => form.get("scope"));

/** A directory connection's status, as core lists it; "gone" when it isn't listed. */
const statusOf = async (connectionId: string): Promise<string> => {
  const listed = await exports.default.directoryConnections();
  return listed.find(({ id }) => id === connectionId)?.status ?? "gone";
};

/** A group as Graph answers the directory's `$select`: a private, assigned security group unless told. */
const graphGroup = (
  fields: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id: guid(),
  displayName: "Finance",
  groupTypes: [],
  securityEnabled: true,
  mailEnabled: false,
  visibility: "Private",
  isAssignableToRole: false,
  onPremisesSyncEnabled: null,
  ...fields,
});

const user = (id = guid()) => ({ "@odata.type": "#microsoft.graph.user", id });

/** The groups a search answered, by name, without their IDs. */
const shown = (groups: DirectoryGroup[]) =>
  groups.map(({ id: _id, ...rest }) => rest);

describe("the directory's groups", () => {
  it("are asked for when the directory is connected: a grant without them is refused", async () => {
    const admin = someone("admin");
    expect({
      without: await outcome(connectDirectory(admin, beforeGroups)),
      with: await outcome(connectDirectory(admin)),
    }).toStrictEqual({ without: "connection.scopes_refused", with: "ok" });
  });

  it("are found by the start of their name, each told by what it is, who sets its members, and why it may not be mapped", async () => {
    const prefix = `Search ${guid()}`;
    const named = (name: string, fields: Record<string, unknown>) =>
      graphGroup({ displayName: `${prefix} ${name}`, ...fields });
    graph.groups = [
      named("owners", {}),
      named("everyone", {
        groupTypes: ["Unified"],
        securityEnabled: false,
        mailEnabled: true,
        visibility: "Public",
      }),
      named("hidden", {
        groupTypes: ["Unified"],
        securityEnabled: false,
        mailEnabled: true,
        visibility: "HiddenMembership",
      }),
      named("rule", { groupTypes: ["DynamicMembership"] }),
      named("synced", { onPremisesSyncEnabled: true }),
      named("admins", { isAssignableToRole: true }),
      named("list", { securityEnabled: false, mailEnabled: true }),
      named("unsaid", {
        visibility: undefined,
        isAssignableToRole: undefined,
        onPremisesSyncEnabled: undefined,
        groupTypes: undefined,
      }),
      named("null", { visibility: null, isAssignableToRole: null }),
      named("synced null", { visibility: null, onPremisesSyncEnabled: true }),
      named("365 null", {
        groupTypes: ["Unified"],
        securityEnabled: false,
        mailEnabled: true,
        visibility: null,
      }),
      named("kind unsaid", { visibility: null, groupTypes: undefined }),
      named("security public", { visibility: "Public" }),
      named("‮planted\u0007", {}),
      named("not entra", { id: "../users" }),
    ];
    const found = await search(await connectDirectory(), prefix);
    expect({ ...found, groups: shown(found.groups) }).toStrictEqual({
      tenant: acmeTenant,
      more: false,
      groups: [
        {
          name: `${prefix} owners`,
          kind: "security",
          membersFrom: "owners",
          refusal: null,
        },
        {
          name: `${prefix} everyone`,
          kind: "microsoft_365",
          membersFrom: "owners",
          refusal: "public",
        },
        {
          name: `${prefix} hidden`,
          kind: "microsoft_365",
          membersFrom: "owners",
          refusal: "hidden_membership",
        },
        {
          name: `${prefix} rule`,
          kind: "security",
          membersFrom: "rule",
          refusal: null,
        },
        {
          name: `${prefix} synced`,
          kind: "security",
          membersFrom: "on_premises",
          refusal: null,
        },
        {
          name: `${prefix} admins`,
          kind: "security",
          membersFrom: "privileged_admins",
          refusal: null,
        },
        {
          name: `${prefix} list`,
          kind: "distribution",
          membersFrom: "owners",
          refusal: null,
        },
        {
          name: `${prefix} unsaid`,
          kind: "unknown",
          membersFrom: "unknown",
          refusal: "unknown",
        },
        // A null visibility is a Microsoft 365 group's matter only.
        {
          name: `${prefix} null`,
          kind: "security",
          membersFrom: "unknown",
          refusal: null,
        },
        {
          name: `${prefix} synced null`,
          kind: "security",
          membersFrom: "on_premises",
          refusal: null,
        },
        {
          name: `${prefix} 365 null`,
          kind: "microsoft_365",
          membersFrom: "owners",
          refusal: "unknown",
        },
        {
          name: `${prefix} kind unsaid`,
          kind: "unknown",
          membersFrom: "unknown",
          refusal: "unknown",
        },
        {
          name: `${prefix} security public`,
          kind: "security",
          membersFrom: "owners",
          refusal: "public",
        },
        {
          name: `${prefix} planted`,
          kind: "security",
          membersFrom: "owners",
          refusal: null,
        },
      ],
    });
  });

  it("are searched by their name as a string, whatever it holds, and say when more match than one page", async () => {
    const prefix = `More ${guid()}`;
    graph.groups = Array.from({ length: 101 }, (_, at) =>
      graphGroup({ displayName: `${prefix} ${at}` })
    );
    const connectionId = await connectDirectory();
    const many = await search(connectionId, prefix);
    const quoted = await search(
      connectionId,
      "O'Brien') or true or startswith(displayName,'"
    );
    const filters = sent
      .filter(({ path }) => path.startsWith(`${groupsPath}?`))
      .map(({ path }) =>
        new URL(path, "https://graph.microsoft.com").searchParams.get("$filter")
      );
    expect({
      many: many.groups.length,
      more: many.more,
      quoted: quoted.groups,
      filter: filters.at(-1),
    }).toStrictEqual({
      many: 100,
      more: true,
      quoted: [],
      filter:
        "startswith(displayName,'O''Brien'') or true or startswith(displayName,''')",
    });
  });

  it("are read page by page, with the users of nested groups, each once, and the groups within counted", async () => {
    const group = graphGroup({ displayName: "Engineering" });
    const [one, two, three] = [guid(), guid(), guid()];
    graph.groups = [group];
    graph.pageSize = 3;
    graph.members[String(group.id)] = [
      user(one),
      { "@odata.type": "#microsoft.graph.group", id: guid() },
      user(two),
      { "@odata.type": "#microsoft.graph.device", id: guid() },
      user(one.toUpperCase()),
      { "@odata.type": "#microsoft.graph.orgContact", id: guid() },
      { "@odata.type": "#microsoft.graph.group", id: guid() },
      user(three),
    ];
    const pages = await readWhole(await connectDirectory(), String(group.id));
    graph.pageSize = 100;
    expect({
      pages: pages.length,
      group: pages.map((page) => page.group?.name ?? null),
      users: new Set(pages.flatMap((page) => page.users)),
      nestedGroups: pages.reduce((sum, page) => sum + page.nestedGroups, 0),
      tenant: pages[0]?.tenant,
    }).toStrictEqual({
      pages: 3,
      group: ["Engineering", null, null],
      users: new Set([one, two, three]),
      nestedGroups: 2,
      tenant: acmeTenant,
    });
  });

  it("are never read past a next link that leaves the group's members, nor from a cursor that does", async () => {
    const group = graphGroup();
    const other = guid();
    graph.groups = [group];
    graph.pageSize = 1;
    graph.members[String(group.id)] = [user(), user()];
    const connectionId = await connectDirectory();
    const groupId = String(group.id);
    const links = [
      `https://graph.microsoft.com/v1.0/groups/${other}/transitiveMembers?$skiptoken=1`,
      "https://graph.microsoft.com/v1.0/users?$skiptoken=1",
      `https://elsewhere.test/v1.0/groups/${groupId}/transitiveMembers?$skiptoken=1`,
      `https://graph.microsoft.com/v1.0/groups/${groupId}/transitiveMembers`,
    ];
    const followed: string[] = [];
    for (const link of links) {
      graph.nextLink = link;
      // oxlint-disable-next-line no-await-in-loop -- one link at a time
      followed.push(await codeOf(readGroup(connectionId, groupId)));
    }
    graph.nextLink = undefined;
    const cursor = await codeOf(readGroup(connectionId, groupId, links[0]));
    graph.pageSize = 100;
    expect({
      followed,
      cursor,
      sentElsewhere: sent.some(({ host }) => host !== "graph.microsoft.com"),
    }).toStrictEqual({
      followed: Array.from(links, () => "directory.provider_failed"),
      cursor: "directory.cursor_invalid",
      sentElsewhere: false,
    });
  });

  it("are read whole or not at all: a group gone before or during the read, or an entry that doesn't say what it is", async () => {
    const group = graphGroup();
    const groupId = String(group.id);
    graph.groups = [group];
    graph.pageSize = 1;
    graph.members[groupId] = [user(), user()];
    const connectionId = await connectDirectory();
    const first = await readGroup(connectionId, groupId);
    // Deleted between two pages.
    graph.groups = [];
    graph.members[groupId] = undefined;
    const midRead = await codeOf(readGroup(connectionId, groupId, first.next));
    const before = await codeOf(readGroup(connectionId, groupId));
    const untyped = graphGroup();
    graph.groups = [untyped];
    graph.members[String(untyped.id)] = [{ id: guid() }];
    const unsaid = await codeOf(readGroup(connectionId, String(untyped.id)));
    graph.pageSize = 100;
    expect({ midRead, before, unsaid }).toStrictEqual({
      midRead: "directory.group_gone",
      before: "directory.group_gone",
      unsaid: "directory.provider_failed",
    });
  });

  it("aren't read for a connection made before Grasp asked for them, which renews with its grant, goes on reading people, and is left as it is", async () => {
    const group = graphGroup();
    const groupId = String(group.id);
    graph.groups = [group];
    graph.members[groupId] = [user()];
    const older = await connectDirectory();
    await madeBeforeGroups(older, { expired: true });
    // Entra renews it with what it was granted then.
    providers.state.refreshGranted = beforeGroups;
    const renewed = await codeOf(readPeople(older));
    const before = sent.length;
    const groups = {
      search: await codeOf(search(older, "Finance")),
      read: await codeOf(readGroup(older, groupId)),
      sentToGraph: sent.length - before,
    };
    providers.state.refreshGranted = undefined;
    expect({
      renewed,
      groups,
      status: await statusOf(older),
      people: await codeOf(readPeople(older)),
    }).toStrictEqual({
      renewed: "ok",
      groups: {
        search: "directory.groups_not_granted",
        read: "directory.groups_not_granted",
        sentToGraph: 0,
      },
      status: "active",
      people: "ok",
    });
  });

  it("are read when the renewal a call is due for brings the scope, and asked for no more", async () => {
    const group = graphGroup();
    const groupId = String(group.id);
    graph.groups = [group];
    graph.members[groupId] = [user()];
    const older = await connectDirectory();
    await madeBeforeGroups(older, { expired: true });
    providers.state.refreshGranted = asAsked;
    const read = await codeOf(readGroup(older, groupId));
    providers.state.refreshGranted = undefined;
    expect({ read, renewals: renewalsAsked().length }).toStrictEqual({
      read: "ok",
      renewals: 1,
    });
  });

  it("answer the instruction, not the moment's failure, when the renewal of a connection made before groups fails, and leave the connection as it is", async () => {
    const older = await connectDirectory();
    await madeBeforeGroups(older, { expired: true });
    providers.state.refresh = () =>
      Response.json({ error: "temporarily_unavailable" }, { status: 503 });
    const failed = await codeOf(search(older, "Finance"));
    providers.state.refresh = undefined;
    expect({ failed, status: await statusOf(older) }).toStrictEqual({
      failed: "directory.groups_not_granted",
      status: "active",
    });
  });

  it("are kept on renewal only as granted before: a renewal that gains a scope, loses one, or says nothing of them needs an admin to connect it again; one that leaves out the sign-in scopes is fine", async () => {
    const renewedWith = async (granted: string | null) => {
      const connectionId = await connectDirectory();
      await drizzle(env.DB)
        .update(connectionTokens)
        .set({ accessExpiresAt: new Date(0) })
        .where(eq(connectionTokens.connectionId, connectionId));
      providers.state.refreshGranted = granted;
      const people = await codeOf(readPeople(connectionId));
      providers.state.refreshGranted = undefined;
      return { people, status: await statusOf(connectionId) };
    };
    const refused = { people: "directory.inactive", status: "needs_reauth" };
    expect({
      gained: await renewedWith(
        `${asAsked} https://graph.microsoft.com/Mail.Read`
      ),
      lost: await renewedWith(
        asAsked.replace(" https://graph.microsoft.com/User.Read.All", "")
      ),
      unsaid: await renewedWith(null),
      signInLeftOut: await renewedWith(
        asAsked.replace("openid profile email ", "")
      ),
    }).toStrictEqual({
      gained: refused,
      lost: refused,
      unsaid: refused,
      signInLeftOut: { people: "ok", status: "active" },
    });
  });

  it("refused by Microsoft to a connection that holds them say so, and leave the connection as it is", async () => {
    const group = graphGroup();
    const groupId = String(group.id);
    graph.groups = [group];
    const holds = await connectDirectory();
    graph.answer = () =>
      Response.json(
        { error: { code: "Authorization_RequestDenied" } },
        { status: 403 }
      );
    const refused = {
      read: await codeOf(readGroup(holds, groupId)),
      search: await codeOf(search(holds, "Finance")),
    };
    graph.answer = undefined;
    expect({ ...refused, status: await statusOf(holds) }).toStrictEqual({
      read: "directory.group_refused",
      search: "directory.group_refused",
      status: "active",
    });
  });

  it("are refused to a connection whose renewal lost them, which then needs an admin to connect it again", async () => {
    const connectionId = await connectDirectory();
    await drizzle(env.DB)
      .update(connectionTokens)
      .set({ accessExpiresAt: new Date(0) })
      .where(eq(connectionTokens.connectionId, connectionId));
    providers.state.refreshGranted = beforeGroups;
    const renewed = await codeOf(search(connectionId, "Finance"));
    providers.state.refreshGranted = undefined;
    const status = await statusOf(connectionId);
    expect({ renewed, status }).toStrictEqual({
      renewed: "directory.inactive",
      status: "needs_reauth",
    });
  });

  it("are never asked for by an ID that isn't Entra's, nor of a Google directory", async () => {
    const connectionId = await connectDirectory();
    const google = await connectDirectory(
      someone("admin"),
      "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/admin.directory.user.readonly",
      "google-directory"
    );
    const before = sent.length;
    expect({
      path: await codeOf(readGroup(connectionId, "../users")),
      googleSearch: await codeOf(search(google, "Finance")),
      googleRead: await codeOf(readGroup(google, guid())),
      sent: sent.length - before,
    }).toStrictEqual({
      path: "directory.invalid",
      googleSearch: "directory.not_found",
      googleRead: "directory.not_found",
      sent: 0,
    });
  });
});
