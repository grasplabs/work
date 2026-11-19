import {
  directoryErrors,
  directoryGroupReadRequestSchema,
  directoryGroupSearchRequestSchema,
  directoryLimits,
} from "@grasp-os/shared/directory";
import type {
  DirectoryGroup,
  DirectoryGroupRead,
  DirectoryGroupSearch,
} from "@grasp-os/shared/directory";
import { z } from "zod";

import {
  activeDirectoryConnection,
  directoryToken,
  graph,
  guidPattern,
  isCursorFor,
  linkedRequest,
  readFailure,
  textOf,
} from "./directory.ts";
import { SourceError, requestBudget } from "./event-kinds.ts";
import type { ProviderAccess } from "./event-kinds.ts";
import { grantHolds } from "./providers.ts";
import { grantedScopesOf } from "./tokens.ts";

// The directory's groups (GRA-2056): an admin maps an Entra group to a
// team, and the daily read places the group's members. Read with the
// directory connection's token, which stays here (directory.ts holds the
// rest of the directory's threat model). The ways this part can go wrong,
// and what stops each:
//
// - The token sent past the directory: only Graph's groups are asked, on
//   paths built here, a group's ID checked as an Entra GUID before it is
//   put in one. A next link is read only for its `$skiptoken`, and only
//   when it names the same host and the same group's members.
// - A search turned into another filter: the text is an OData string
//   literal, its quotes doubled (OData's own rule), and URL-encoded.
// - A fact `Group.ReadBasic.All` doesn't answer taken as fine: what a
//   group answers is unproved on a real tenant, so anything missing or
//   null is `unknown`, and an unknown visibility is a refusal: core maps
//   no group with one. Two nulls have the meaning Microsoft documents:
//   `onPremisesSyncEnabled` null is "never synced", and a null visibility
//   matters only for a Microsoft 365 group (`refusalOf`).
// - A partial member list taken for the whole: every entry must say its
//   type, a page past Graph's largest fails, and only a page without a
//   next link ends a group. A group gone mid-read (404) is
//   `directory.group_gone`, never an empty group.
// - A connection made before groups were asked for: its renewals keep
//   the grant it has (providers.ts `renewedAsGranted`), so it goes on
//   reading people, leavers and teams. Its group calls answer
//   `directory.groups_not_granted` (`groupsToken`), send nothing to
//   Graph, and leave the connection as it is: an admin connects the
//   directory again (Settings › Members), which renews it in place with
//   the scope (oauth.ts `renewsInPlace`).
//   A refusal with the scope held is Microsoft's own
//   (`directory.group_refused`), which connecting again doesn't mend.
// - Personal data: of members, only Entra object IDs leave connect, and a
//   count of the groups nested within. Group names are cleaned like any
//   directory text.
// - Google: its groups wait on proof that its sign-in IDs are its
//   directory's; a Google connection is `directory.not_found` here.

const graphHost = "graph.microsoft.com";
const graphGroupsPath = "/v1.0/groups";

/** What a group is asked for: what decides its kind, who sets its members, and whether it may be mapped. */
const groupSelect =
  "id,displayName,groupTypes,securityEnabled,mailEnabled,visibility,isAssignableToRole,onPremisesSyncEnabled";

const graphGroupSchema = z.object({
  id: z.string(),
  displayName: z.string().nullish(),
  groupTypes: z.array(z.string()).nullish(),
  securityEnabled: z.boolean().nullish(),
  mailEnabled: z.boolean().nullish(),
  visibility: z.string().nullish(),
  isAssignableToRole: z.boolean().nullish(),
  onPremisesSyncEnabled: z.boolean().nullish(),
});
type GraphGroup = z.output<typeof graphGroupSchema>;

const graphGroupPageSchema = z.object({
  value: z.array(graphGroupSchema),
  "@odata.nextLink": z.string().optional(),
});

/** A member as Graph lists one: every entry says its type. */
const graphMemberPageSchema = z.object({
  value: z.array(z.object({ "@odata.type": z.string(), id: z.string() })),
  "@odata.nextLink": z.string().optional(),
});

const userType = "#microsoft.graph.user";
const groupType = "#microsoft.graph.group";

/** Whether `types` (a group's `groupTypes`) names `type`, in any case. */
const names = (types: readonly string[], type: string): boolean =>
  types.some((each) => each.toLowerCase() === type);

const kindOf = ({
  groupTypes,
  securityEnabled,
  mailEnabled,
}: GraphGroup): DirectoryGroup["kind"] => {
  if (groupTypes === null || groupTypes === undefined) {
    return "unknown";
  }
  if (names(groupTypes, "unified")) {
    return "microsoft_365";
  }
  if (securityEnabled === true) {
    return "security";
  }
  if (securityEnabled === false && mailEnabled === true) {
    return "distribution";
  }
  return "unknown";
};

const membersFromOf = ({
  groupTypes,
  isAssignableToRole,
  onPremisesSyncEnabled,
}: GraphGroup): DirectoryGroup["membersFrom"] => {
  // Null is documented: never synced from on-premises.
  if (onPremisesSyncEnabled === true) {
    return "on_premises";
  }
  if (
    onPremisesSyncEnabled === undefined ||
    groupTypes === null ||
    groupTypes === undefined
  ) {
    return "unknown";
  }
  if (names(groupTypes, "dynamicmembership")) {
    return "rule";
  }
  if (isAssignableToRole === true) {
    return "privileged_admins";
  }
  return isAssignableToRole === false ? "owners" : "unknown";
};

/** Each visibility Microsoft documents, as a refusal to map; any other is unknown. */
const refusals = new Map<string, DirectoryGroup["refusal"]>([
  ["private", null],
  ["public", "public"],
  ["hiddenmembership", "hidden_membership"],
]);

/**
 * Why `group` may not be a team's, from its visibility. Microsoft
 * documents visibility as a Microsoft 365 group's join policy (Public:
 * "anyone can join"; HiddenMembership "only for Microsoft 365 groups"),
 * and security groups made in the admin centre or synced from AD often
 * answer it null. So a null visibility is no refusal for a group known
 * not to be a Microsoft 365 one; for one that is, or whose kind Microsoft
 * didn't answer, it is unknown, as is a visibility not answered at all or
 * not documented. Public and HiddenMembership refuse whatever the kind.
 */
const refusalOf = ({
  visibility,
  groupTypes,
}: GraphGroup): DirectoryGroup["refusal"] => {
  if (visibility === null) {
    const notMicrosoft365 =
      groupTypes !== null &&
      groupTypes !== undefined &&
      !names(groupTypes, "unified");
    return notMicrosoft365 ? null : "unknown";
  }
  const refusal =
    visibility === undefined
      ? undefined
      : refusals.get(visibility.toLowerCase());
  return refusal === undefined ? "unknown" : refusal;
};

/** `group` as an admin is shown it; none when its ID isn't Entra's. */
const groupOf = (group: GraphGroup): DirectoryGroup[] =>
  guidPattern.test(group.id)
    ? [
        {
          id: group.id.toLowerCase(),
          name: textOf(group.displayName),
          kind: kindOf(group),
          membersFrom: membersFromOf(group),
          refusal: refusalOf(group),
        },
      ]
    : [];

/** `text` as an OData string literal's content: its quotes doubled. */
const odataString = (text: string): string => text.replaceAll("'", "''");

const searchUrl = (query: string): URL => {
  const url = new URL(`https://${graphHost}${graphGroupsPath}`);
  url.searchParams.set(
    "$filter",
    `startswith(displayName,'${odataString(query)}')`
  );
  url.searchParams.set("$select", groupSelect);
  url.searchParams.set("$top", String(directoryLimits.groupsPerSearch));
  return url;
};

const groupUrl = (groupId: string): URL => {
  const url = new URL(`https://${graphHost}${graphGroupsPath}/${groupId}`);
  url.searchParams.set("$select", groupSelect);
  return url;
};

/**
 * A group's members, nested groups' included. Asked with no query option:
 * any but `$expand` makes it an advanced query, answered from an index
 * Microsoft says may lag behind a change; Graph's own page size applies.
 */
const membersUrl = (groupId: string): URL =>
  new URL(
    `https://${graphHost}${graphGroupsPath}/${groupId}/transitiveMembers`
  );

/** The request a read of `groupId`'s members sends, at `cursor`. */
const membersRequestOf = (groupId: string, cursor: string | null): URL =>
  linkedRequest(membersUrl(groupId), "$skiptoken", cursor);

/** The scope the groups' calls are made with (providers.ts). */
const groupsScope = "Group.ReadBasic.All";

/** Whether `connectionId`'s grant, as connect kept it, holds the groups' scope. */
const holdsGroups = async (
  env: Env,
  connectionId: string
): Promise<boolean> => {
  const granted = await grantedScopesOf(env, connectionId);
  return granted !== null && grantHolds(granted, groupsScope);
};

/**
 * The access token of `connection` for a groups call.
 *
 * Renewed first, as any call renews a token that is due, and only then
 * is the grant judged, as it stands after: so a renewal that brings the
 * groups' scope counts at once. A connection made before Grasp asked for
 * the scope (it renews with what it holds, and goes on reading people)
 * answers `directory.groups_not_granted`: nothing is sent, and nothing
 * marks it. A renewal that fails, on a connection whose grant lacked the
 * scope before it, answers the same: the instruction an admin can act
 * on, not the moment's failure, which the people's read reports itself.
 */
const groupsToken = async (env: Env, connectionId: string): Promise<string> => {
  const heldBefore = await holdsGroups(env, connectionId);
  let token: string;
  try {
    token = await directoryToken(env, connectionId);
  } catch (error) {
    if (heldBefore) {
      throw error;
    }
    throw directoryErrors.create("directory.groups_not_granted");
  }
  if (!(await holdsGroups(env, connectionId))) {
    throw directoryErrors.create("directory.groups_not_granted");
  }
  return token;
};

/**
 * Graph refusing a groups call, as the directory's error: with the scope
 * held, Microsoft refused this read (`directory.group_refused`), which
 * connecting again doesn't mend; the connection stays as it is.
 */
const groupsFailure = (error: unknown): unknown =>
  error instanceof SourceError && error.status === 403
    ? directoryErrors.create("directory.group_refused")
    : readFailure(error, "microsoft-directory");

/** An Entra directory connection, active; any other is `directory.not_found`. */
const entraConnection = async (env: Env, connectionId: string) => {
  const connection = await activeDirectoryConnection(env, connectionId);
  if (connection.provider !== "microsoft-directory") {
    throw directoryErrors.create("directory.not_found");
  }
  return connection;
};

/** Searches an Entra directory connection's groups by the start of their name: one page of them. */
export const searchDirectoryGroups = async (
  env: Env,
  request: unknown
): Promise<DirectoryGroupSearch> => {
  const { connectionId, query } = directoryErrors.parse(
    "directory.invalid",
    directoryGroupSearchRequestSchema,
    request
  );
  const connection = await entraConnection(env, connectionId);
  const access: ProviderAccess = {
    token: await groupsToken(env, connection.connectionId),
    budget: requestBudget(1),
  };
  let page: z.output<typeof graphGroupPageSchema>;
  try {
    page = graphGroupPageSchema.parse(
      await graph(access, searchUrl(query).href)
    );
  } catch (error) {
    throw groupsFailure(error);
  }
  if (page.value.length > directoryLimits.groupsPerSearch) {
    throw directoryErrors.create("directory.provider_failed");
  }
  return {
    tenant: connection.tenant,
    groups: page.value.flatMap(groupOf),
    more: page["@odata.nextLink"] !== undefined,
  };
};

/**
 * Reads one page of an Entra group's members, nested groups' included,
 * from `cursor` on; on the first page (no cursor), the group itself too.
 */
export const readDirectoryGroup = async (
  env: Env,
  request: unknown
): Promise<DirectoryGroupRead> => {
  const { connectionId, groupId, cursor } = directoryErrors.parse(
    "directory.invalid",
    directoryGroupReadRequestSchema,
    request
  );
  const connection = await entraConnection(env, connectionId);
  if (!guidPattern.test(groupId)) {
    throw directoryErrors.create("directory.invalid");
  }
  const id = groupId.toLowerCase();
  const url = membersRequestOf(id, cursor);
  const access: ProviderAccess = {
    token: await groupsToken(env, connection.connectionId),
    budget: requestBudget(cursor === null ? 2 : 1),
  };
  let group: DirectoryGroup | null = null;
  let page: z.output<typeof graphMemberPageSchema>;
  try {
    if (cursor === null) {
      [group = null] = groupOf(
        graphGroupSchema.parse(await graph(access, groupUrl(id).href))
      );
      if (group?.id !== id) {
        throw directoryErrors.create("directory.provider_failed");
      }
    }
    page = graphMemberPageSchema.parse(await graph(access, url.href));
  } catch (error) {
    if (error instanceof SourceError && error.status === 404) {
      throw directoryErrors.create("directory.group_gone");
    }
    throw groupsFailure(error);
  }
  const next = page["@odata.nextLink"] ?? null;
  // A next link elsewhere (another endpoint, another group), or a page
  // past what Graph puts on one, is never kept, nor taken for the end.
  if (
    (next !== null && !isCursorFor((at) => membersRequestOf(id, at), next)) ||
    page.value.length > directoryLimits.groupMembersPerPage
  ) {
    throw directoryErrors.create("directory.provider_failed");
  }
  const users = new Set<string>();
  let nestedGroups = 0;
  for (const member of page.value) {
    const type = member["@odata.type"].toLowerCase();
    if (type === userType && guidPattern.test(member.id)) {
      users.add(member.id.toLowerCase());
    } else if (type === groupType) {
      nestedGroups += 1;
    }
  }
  return {
    tenant: connection.tenant,
    group,
    users: [...users],
    nestedGroups,
    next,
  };
};
