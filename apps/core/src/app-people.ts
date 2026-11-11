import {
  isPeopleFunctionName,
  peopleLimits,
  peopleFunctions,
  schemaFromDescriptor,
} from "@grasp-os/runtime/host";
import type {
  PeopleFunctionName,
  PeoplePage,
  Person,
  TeamRef,
  User,
} from "@grasp-os/runtime/host";
import type { AuditActor } from "@grasp-os/shared/audit";
import type { AppId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { operationErrors } from "@grasp-os/shared/operations";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { WriterRoles } from "@grasp-os/shared/stores";
import { and, asc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { keepAuditEvent } from "./audit-outbox.ts";
import { currentMembership, notRemoved, organizationId } from "./auth/auth.ts";
import { realEmail } from "./auth/directory-members.ts";
import { members, teamMembers, teams, users } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";

// Who calls an App, and the organization's people (GRA-1474): what App
// code reads as `ctx.auth.getUser()` and `ctx.people`, and a page as
// `useUser()` and `usePeople()` (runtime/src/people.ts). Core answers both
// itself. Threat model, and how each is closed:
//
// - A page or App code makes up who calls: the user is read here from
//   core's own record of the call (the member's verified session, the
//   person a run acts for, the visitor's session), never from a request;
//   no read takes a person to be. A page that shows another name fools
//   only itself: the App's server code decides with
//   `ctx.auth.getUser()`, which no page reaches.
// - Any App, or an agent through one, harvests the organization: only an
//   App that declares it reads the directory (`permissions: { people: true }`,
//   which its versions' review shows); any other read is refused
//   (`permission.denied`) and recorded (`app.people.refused`). An agent
//   reads it only through such an App.
// - A visitor reads the directory: a visitor's call has no directory,
//   only who they are (their session's ID and address). Asking for it is
//   refused as a function the App doesn't grant them, and recorded
//   (`app.visitor_refused`), from a page and from App code alike.
// - Someone removed, or not a member, is read or reads: every read is of
//   the organization's current members only (a membership, and no removal
//   recorded); a caller who lost theirs is refused
//   (`permission.person_inactive`).
// - Paging through everyone: what limits it is the opt-in above (only a
//   declared App reads at all), the cap of 100 people a read
//   (`peopleLimits.pageMax`, with a function's 100 host calls,
//   function-channel.ts), and the record of every read
//   (`app.people.read`: the App, the person it read for, which read and
//   how many people it answered, never whom). A declared App can still
//   page through every member, read by read, on the record. A search's 2
//   letters or digits only stop a match-all search ("@", "."); two
//   letters still match many.
// - A read tells more than a directory entry: a person is their ID, name,
//   email and teams, read field by field, never their role, sessions or
//   anything else of theirs; the placeholder address of someone made from
//   the directory who never signed in is null, and is never searched. A
//   team is its ID and name.
// - A read too large to bother with: arguments are checked by the SDK's
//   declared contract (people.ts) before anything is read; a search is a
//   bounded substring, its `%`, `_` and `\` taken literally.

/** Who calls and what they may read, as core resolved it for one call. */
export interface PeopleAccess {
  /** Who calls, read once and kept for the call. */
  readonly user: () => Promise<User>;
  /**
   * Reads the directory for the caller: absent where they may not, whose
   * reads `refuse` refuses.
   */
  readonly directory?: Directory;
  /** Refuses the directory read `name`, recorded; never returns. */
  readonly refuse?: (name: PeopleFunctionName) => Promise<never>;
}

type DirectoryRead = Exclude<PeopleFunctionName, "user">;

type Directory = (
  name: DirectoryRead,
  args: Record<string, Json>
) => Promise<Json>;

/** The schema each read's arguments are checked by, read once. */
const argsSchemas = new Map<
  PeopleFunctionName,
  ReturnType<typeof schemaFromDescriptor>
>();

/** `args` checked by read `name`'s declared arguments, normalized. */
const checkedArgs = (
  name: PeopleFunctionName,
  args: unknown
): Record<string, Json> => {
  let schema = argsSchemas.get(name);
  if (schema === undefined) {
    schema = schemaFromDescriptor(JSON.stringify(peopleFunctions[name].args));
    argsSchemas.set(name, schema);
  }
  const result = schema["~standard"].validate(args);
  if (result.issues !== undefined) {
    throw operationErrors.create("contract.invalid_args");
  }
  // SAFETY: an object descriptor admits a JSON object only.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return result.value as Record<string, Json>;
};

/**
 * Answers read `name` with `args` (App code's, or a page's), for the
 * caller `access` names: who calls, or a directory read. Anything else
 * is a read that doesn't exist (`function.not_found`).
 */
export const answerPeople = async (
  access: PeopleAccess,
  name: unknown,
  args: unknown
): Promise<Json> => {
  if (!isPeopleFunctionName(name)) {
    throw operationErrors.create("function.not_found");
  }
  const checked = checkedArgs(name, args);
  if (name === "user") {
    return await access.user();
  }
  if (access.directory === undefined) {
    if (access.refuse !== undefined) {
      return await access.refuse(name);
    }
    throw permissionErrors.create("permission.denied");
  }
  return await access.directory(name, checked);
};

/**
 * The read `name` names, for a page's call of `people.<read>`
 * (`peopleReferences`, people.ts): undefined for any other path. What it
 * takes is checked by the read's own contract (`checkedArgs`). The
 * reference names no App: the App is the one the call was made through.
 */
export const peopleReadOf = (reference: {
  readonly name: string;
  readonly kind: string;
}): PeopleFunctionName | undefined => {
  const [segment, name, ...rest] = reference.name.split(".");
  if (segment !== "people") {
    return undefined;
  }
  if (rest.length > 0 || !isPeopleFunctionName(name)) {
    throw operationErrors.create("function.not_found");
  }
  if (reference.kind !== "query") {
    throw operationErrors.create("function.kind_mismatch");
  }
  return name;
};

/** Whether `name` is under the platform's `people` segment. */
export const isPeoplePath = (name: string): boolean =>
  name.startsWith("people.");

/** The organization's current members: a membership, and no removal. */
const currentMember = and(
  eq(members.organizationId, organizationId),
  notRemoved(members.userId)
);

/** Each person's teams in the organization, by name, for `ids`. */
const teamsByPerson = async (
  env: Env,
  ids: readonly string[]
): Promise<Map<string, TeamRef[]>> => {
  const found = new Map<string, TeamRef[]>();
  if (ids.length === 0) {
    return found;
  }
  const rows = await drizzle(env.DB)
    .select({ userId: teamMembers.userId, id: teams.id, name: teams.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(
      and(
        inList(teamMembers.userId, ids),
        eq(teams.organizationId, organizationId)
      )
    )
    .orderBy(asc(teams.name), asc(teams.id));
  for (const row of rows) {
    const list = found.get(row.userId) ?? [];
    list.push({ id: row.id, name: row.name });
    found.set(row.userId, list);
  }
  return found;
};

/** `rows` as the directory answers them, with their teams. */
const peopleOf = async (
  env: Env,
  rows: readonly { id: string; name: string; email: string }[]
): Promise<Person[]> => {
  const teamsOfPeople = await teamsByPerson(
    env,
    rows.map((row) => row.id)
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: realEmail(row.email),
    teams: teamsOfPeople.get(row.id) ?? [],
  }));
};

/** A page's cursor: where it starts, as the previous page handed it over. */
const offsetPattern = /^\d{1,6}$/u;

/** Where a page starts: 0, or the offset its cursor carries. */
const offsetOf = (cursor: Json | undefined): number => {
  if (cursor === null || cursor === undefined) {
    return 0;
  }
  if (typeof cursor !== "string" || !offsetPattern.test(cursor)) {
    throw operationErrors.create("contract.invalid_args");
  }
  return Number(cursor);
};

/** Reads a page of members matching `where`, by name, from `cursor`. */
const pageOf = async (
  env: Env,
  where: SQL | undefined,
  args: Record<string, Json>,
  fromTeam?: string
): Promise<PeoplePage> => {
  const limit = typeof args.limit === "number" ? args.limit : 1;
  const offset = offsetOf(args.cursor);
  const db = drizzle(env.DB);
  const base = db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .innerJoin(members, eq(members.userId, users.id));
  const joined =
    fromTeam === undefined
      ? base
      : base
          .innerJoin(teamMembers, eq(teamMembers.userId, users.id))
          .innerJoin(teams, eq(teams.id, teamMembers.teamId));
  // One more than the page, to know whether there is a next.
  const rows = await joined
    .where(
      and(
        currentMember,
        where,
        fromTeam === undefined
          ? undefined
          : and(
              eq(teams.id, fromTeam),
              eq(teams.organizationId, organizationId)
            )
      )
    )
    .orderBy(asc(users.name), asc(users.id))
    .limit(limit + 1)
    .offset(offset);
  const people = await peopleOf(env, rows.slice(0, limit));
  return {
    people,
    next: rows.length > limit ? String(offset + limit) : null,
  };
};

/** `text` for a `LIKE` pattern, its wildcards and escape taken literally. */
const likeLiteral = (text: string): string =>
  text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

/** A letter or digit of any script. */
const letterOrDigit = /[\p{L}\p{N}]/gu;

/** The placeholder addresses of members who never signed in: never searched. */
const placeholderPattern = "%@directory.invalid";

/** The directory's reads, for a member: `find`, `search` and `team`. */
const directoryReads: Readonly<
  Record<DirectoryRead, (env: Env, args: Record<string, Json>) => Promise<Json>>
> = {
  find: async (env, args) => {
    const ids = Array.isArray(args.ids)
      ? [...new Set(args.ids.filter((id) => typeof id === "string"))]
      : [];
    if (ids.length === 0) {
      return [];
    }
    const rows = await drizzle(env.DB)
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .innerJoin(members, eq(members.userId, users.id))
      .where(and(currentMember, inList(users.id, ids)))
      .orderBy(asc(users.name), asc(users.id));
    return await peopleOf(env, rows);
  },
  search: async (env, args) => {
    const query = typeof args.query === "string" ? args.query : "";
    // "@" or "." would match everyone: a search names someone.
    if (
      (query.match(letterOrDigit)?.length ?? 0) <
      peopleLimits.queryMinCharacters
    ) {
      throw operationErrors.create("contract.invalid_args");
    }
    // LIKE folds ASCII case itself; any other letter matches as written.
    const pattern = `%${likeLiteral(query)}%`;
    return await pageOf(
      env,
      sql`(${users.name} LIKE ${pattern} ESCAPE '\\' OR (${users.email} LIKE ${pattern} ESCAPE '\\' AND ${users.email} NOT LIKE ${placeholderPattern}))`,
      args
    );
  },
  team: async (env, args) =>
    await pageOf(
      env,
      undefined,
      args,
      typeof args.teamId === "string" ? args.teamId : ""
    ),
};

/** How many people a read answered, for its record. */
const countOf = (answer: Json): number => {
  if (Array.isArray(answer)) {
    return answer.length;
  }
  const people: unknown =
    typeof answer === "object" && answer !== null
      ? Reflect.get(answer, "people")
      : undefined;
  return Array.isArray(people) ? people.length : 0;
};

/** Who reads, and for which App, as a member's access records it. */
export interface MemberReader {
  readonly app: AppId;
  /** The member the call is for. */
  readonly userId: string;
  /** Their roles in the App, as the call's gate read them last. */
  readonly roles: () => Promise<WriterRoles>;
  /** Whether the App declares it reads the organization's people. */
  readonly declared: boolean;
  /** Who the audit log names as reading: the App's server or page, or an agent. */
  readonly actor: AuditActor;
  readonly requestId: string;
}

/** A member's roles in an App (`appRoles`): a builder is a user too. */
const rolesOf = (builder: boolean): User["roles"] =>
  builder ? ["builder", "user"] : ["user"];

/**
 * Who `userId` is, as a member calling the App: one read of their name
 * and address, with the App roles the call already has. Refused once
 * they are no member.
 */
const personUser = async (
  env: Env,
  { userId, roles }: MemberReader
): Promise<User> => {
  const [row, appRoles] = await Promise.all([
    drizzle(env.DB)
      .select({ name: users.name, email: users.email })
      .from(users)
      .innerJoin(members, eq(members.userId, users.id))
      .where(currentMembership(userId))
      .get(),
    roles(),
  ]);
  if (row === undefined) {
    throw permissionErrors.create("permission.person_inactive");
  }
  return {
    id: userId,
    name: row.name,
    email: realEmail(row.email),
    roles: rolesOf(appRoles.appBuilder),
  };
};

/** `read`, kept for the call: the first answer, or the first failure. */
const once = <Answer>(read: () => Promise<Answer>): (() => Promise<Answer>) => {
  let kept: Promise<Answer> | undefined;
  return async () => {
    kept ??= read();
    return await kept;
  };
};

/**
 * A member's access: who they are, and, when the App declares it, the
 * directory, each read of which is recorded as `app.people.read`; an App
 * that doesn't is refused each read, recorded as `app.people.refused`.
 */
export const memberPeople = (env: Env, reader: MemberReader): PeopleAccess => {
  const user = once(async () => await personUser(env, reader));
  const audit = async (action: string, detail: Record<string, Json>) => {
    await keepAuditEvent(env, drizzle(env.DB), {
      actor: reader.actor,
      action,
      target: { type: "app", id: reader.app },
      requestId: reader.requestId,
      detail: { person: reader.userId, ...detail },
    });
  };
  if (!reader.declared) {
    return {
      user,
      refuse: async (name) => {
        await audit("app.people.refused", { read: name, reason: "undeclared" });
        throw permissionErrors.create("permission.denied");
      },
    };
  }
  return {
    user,
    directory: async (name, args) => {
      // A member, with a role in the App, as the call found them.
      await user();
      const answer = await directoryReads[name](env, args);
      await audit("app.people.read", { read: name, count: countOf(answer) });
      return answer;
    },
  };
};

/**
 * A visitor's access: who they are (their session's principal and
 * address), and no directory: `refuse` records and refuses each read.
 */
export const visitorPeople = ({
  principal,
  email,
  refuse,
}: {
  readonly principal: string;
  readonly email: string;
  readonly refuse: (name: PeopleFunctionName) => Promise<never>;
}): PeopleAccess => ({
  user: async () =>
    await Promise.resolve({ id: principal, name: email, email, roles: [] }),
  refuse,
});

/**
 * What an App's tests are told of people (app-tests.ts): the fixture
 * principal as the person calling, in its role, and, when the App
 * declares the directory, an empty one, as the tests reach no one outside
 * them.
 */
export const fixturePeople = (
  principal: string,
  shownAs: string,
  role: "user" | "builder",
  declared: boolean
): PeopleAccess => ({
  user: async () =>
    await Promise.resolve({
      id: principal,
      name: shownAs,
      email: null,
      roles: rolesOf(role === "builder"),
    }),
  ...(declared
    ? {
        directory: async (name: DirectoryRead) =>
          await Promise.resolve(
            name === "find" ? [] : { people: [], next: null }
          ),
      }
    : {}),
});
