import type { OperationManifest } from "./app.ts";
import type { OperationReference } from "./references.ts";
import { descriptorOf } from "./value-schema.ts";
import { v } from "./values.ts";
import type { Infer, InferInput } from "./values.ts";

// Who calls an App, and the organization's people (GRA-1474): what an
// App's server functions read as `ctx.auth.getUser()` and `ctx.people`,
// and its screens as `useUser()` and `usePeople()`, as Convex's read
// `ctx.auth`. Core answers both itself, from its own record of who is
// signed in and who is a member, never from anything a screen or App code
// sends: a screen that makes up a user fools only itself, and every
// decision that matters is the server's.
//
// The directory is read-only and bounded, and only an App that declares it
// (`app({ permissions: { people: true } })`) reads it: a member finds people by ID, by name
// or email, or by team, at most `peopleLimits.pageMax` a read, and each
// person comes with their name, email and teams, nothing else. A visitor
// (someone outside the organization an App was shared with) is told who
// they are, and is refused the directory.

/** The bounds of a directory read. */
export const peopleLimits = {
  /** People one read answers, at most: a page, or the IDs `find` takes. */
  pageMax: 100,
  /** People a page answers unless it asks for fewer. */
  pageDefault: 25,
  /** The longest search. */
  queryMaxLength: 100,
  /**
   * The fewest letters or digits a search holds, so a match-all search
   * ("@", ".") is refused. It doesn't stop harvesting: the opt-in, the cap
   * a read and the audit log do that.
   */
  queryMinCharacters: 2,
  /** The longest ID or cursor. */
  idMaxLength: 128,
} as const;

const id = v.string().min(1).max(peopleLimits.idMaxLength);
const name = v.string();
/** Their address; null for someone who has no real one yet. */
const email = v.string().nullable();
const team = v.object({ id, name });

/** A team, by ID and name. */
export type TeamRef = Infer<typeof team>;

/**
 * The roles someone holds in an App: `builder` for its builders (an
 * admin builds every App), `user` for everyone with a role in it, its
 * builders included, as a row rule's `role("user")` admits them. A
 * visitor (someone outside the organization the App was shared with)
 * holds none.
 */
export const appRoles = ["builder", "user"] as const;

const user = v.object({
  /**
   * Who they are: a member's ID, the same in every App. A visitor's is
   * their session's, which owns what they insert and changes each time
   * they sign in: key what a visitor keeps by their `email`.
   */
  id,
  /** Their name; a visitor's address, as they have no other. */
  name,
  /** Their address; null for a member who has no real one yet. */
  email,
  /** Their roles in the App (`appRoles`); none for a visitor. */
  roles: v.array(v.enum(appRoles)),
});

/** Who is calling: from core's verified identity, never from the client. */
export type User = Infer<typeof user>;

const person = v.object({ id, name, email, teams: v.array(team) });

/** A member of the organization, as the directory answers them. */
export type Person = Infer<typeof person>;

const page = v.object({
  people: v.array(person).max(peopleLimits.pageMax),
  /** Where the next page starts; null on the last. */
  next: v.string().max(peopleLimits.idMaxLength).nullable(),
});

/** One page of a directory read. */
export type PeoplePage = Infer<typeof page>;

const paging = {
  limit: v
    .number()
    .integer()
    .min(1)
    .max(peopleLimits.pageMax)
    .default(peopleLimits.pageDefault),
  cursor: v
    .string()
    .min(1)
    .max(peopleLimits.idMaxLength)
    .nullable()
    .default(null),
};

/** Each directory read's arguments and answer: one contract for both sides. */
const contracts = {
  user: { args: v.object({}), returns: user },
  find: {
    args: v.object({ ids: v.array(id).max(peopleLimits.pageMax) }),
    returns: v.array(person).max(peopleLimits.pageMax),
  },
  search: {
    args: v.object({
      query: v.string().trim().min(1).max(peopleLimits.queryMaxLength),
      ...paging,
    }),
    returns: page,
  },
  team: { args: v.object({ teamId: id, ...paging }), returns: page },
} as const;

/** The names of the reads: who calls (`user`), and the directory's three. */
export type PeopleOperationName = keyof typeof contracts;

/** Whether `read` is one of the reads. */
export const isPeopleOperationName = (
  read: unknown
): read is PeopleOperationName =>
  typeof read === "string" && Object.hasOwn(contracts, read);

/** Read `read`, as an App's public query is described. */
const described = (read: PeopleOperationName): OperationManifest =>
  Object.freeze({
    path: `people.${read}`,
    kind: "query",
    visibility: "public",
    args: descriptorOf(contracts[read].args),
    returns: descriptorOf(contracts[read].returns),
    stream: null,
    uses: [],
    tables: {},
  });

/** Each read, as an App's public query is described. */
export const peopleOperations: Readonly<
  Record<PeopleOperationName, OperationManifest>
> = Object.freeze({
  user: described("user"),
  find: described("find"),
  search: described("search"),
  team: described("team"),
});

/**
 * Each read's contract fingerprint (`contractFingerprint`), fixed here so
 * a screen names it without a digest: core refuses a read whose
 * fingerprint isn't the one its own SDK makes (`version.mismatch`), so a
 * screen sealed with another contract is told, never answered in a shape
 * it doesn't expect. people.test.ts holds them to the contracts.
 */
export const peopleFingerprints: Readonly<Record<PeopleOperationName, string>> =
  {
    user: "0dbe0da92407b09709500f34a8b1e0a0dfddda4bf84492ee43546584f410013f",
    find: "f1538b1cacfa22be9293d76140ae785efa4a000e2d14ddaf3b5eb7bb4c1187bb",
    search: "56bdf9f1ce66d252e0c36f25e4a0910560000532b910ed4ca77e7d88c3b964e5",
    team: "bc78994e9287646b568949cdc4a0c38f6399c11cb6ed156bb0fda82121cb5482",
  };

/** The reference a screen reads `Name` through. */
type PeopleReference<Name extends PeopleOperationName> = OperationReference<
  InferInput<(typeof contracts)[Name]["args"]>,
  Infer<(typeof contracts)[Name]["returns"]>,
  "query"
>;

/** The reference to read `read`. */
const referenceTo = <Name extends PeopleOperationName>(
  read: Name
): PeopleReference<Name> =>
  Object.freeze({
    resourceId: "people",
    resourceVersion: 1,
    contractId: peopleOperations[read].path,
    fingerprint: peopleFingerprints[read],
    kind: "query",
    mode: "single",
    visibility: "public",
    args: peopleOperations[read].args,
    returns: peopleOperations[read].returns,
  });

/**
 * The references a screen reads through (`useUser`, `usePeople`). They
 * name no App: the screen's page binds its calls to its own App, and core
 * answers them for that App and the person signed in there, whatever a
 * reference says. So they work in Grasp's own screens only; a portable
 * host reads who calls through one of the App's functions.
 */
export const peopleReferences = Object.freeze({
  user: referenceTo("user"),
  find: referenceTo("find"),
  search: referenceTo("search"),
  team: referenceTo("team"),
});

/** Options of a paged read: how many (1 to 100, 25 unless set) and from where. */
export interface PageOptions {
  readonly limit?: number;
  readonly cursor?: string | null;
}

/**
 * The organization's people, read-only, for the members of an App that
 * declares it (`app({ permissions: { people: true } })`; `permission.denied` otherwise),
 * never for a visitor (`visitor.not_granted`). Each read answers at most
 * 100.
 */
export interface PeopleDirectory {
  /** The people with these IDs (at most 100) who are members; others are left out. */
  readonly find: (ids: readonly string[]) => Promise<Person[]>;
  /**
   * Members whose name or email holds `query` (at least 2 letters or
   * digits), by name.
   */
  readonly search: (
    query: string,
    options?: PageOptions
  ) => Promise<PeoplePage>;
  /** The members of team `teamId`, by name; none for a team that isn't there. */
  readonly team: (teamId: string, options?: PageOptions) => Promise<PeoplePage>;
}

/** What of `options` a read sends: only what was set. */
const paged = (options: PageOptions | undefined) => ({
  ...(options?.limit === undefined ? {} : { limit: options.limit }),
  ...(options?.cursor === undefined ? {} : { cursor: options.cursor }),
});

/**
 * A directory over `read`, which answers one read by name and arguments,
 * as core checked it against the read's declared return.
 */
export const peopleDirectory = (
  read: (operation: PeopleOperationName, args: object) => Promise<unknown>
): PeopleDirectory => {
  const directory: PeopleDirectory = {
    find: async (ids) => {
      // SAFETY: core checked the answer against `find`'s declared return.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      const found = (await read("find", { ids: [...ids] })) as Person[];
      return found;
    },
    search: async (query, options) => {
      // SAFETY: core checked the answer against `search`'s declared return.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      const found = (await read("search", {
        query,
        ...paged(options),
      })) as PeoplePage;
      return found;
    },
    team: async (teamId, options) => {
      // SAFETY: core checked the answer against `team`'s declared return.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      const found = (await read("team", {
        teamId,
        ...paged(options),
      })) as PeoplePage;
      return found;
    },
  };
  return Object.freeze(directory);
};
