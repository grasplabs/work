import type { OperationManifest } from "./app.ts";
import type { OperationReference } from "./references.ts";
import { descriptorOf } from "./value-schema.ts";
import { v } from "./values.ts";
import type { Infer, InferInput } from "./values.ts";

// Who calls an App, and the organization's people (GRA-1474): what an
// App's server functions read as `ctx.caller` and `ctx.people`, and its
// screens as `useCaller()` and `usePeople()`. Core answers both itself,
// from its own record of who is signed in and who is a member, never from
// anything a screen or App code sends: a screen that makes up a caller
// fools only itself, and every decision that matters is the server's.
//
// The directory is read-only and bounded: a member finds people by ID, by
// name or email, or by team, at most `peopleLimits.pageMax` a read, and
// each person comes with their name, email, teams and manager, nothing
// else. A visitor (someone outside the organization an App was shared
// with) is told who they are, and is refused the directory.

/** The bounds of a directory read. */
export const peopleLimits = {
  /** People one read answers, at most: a page, or the IDs `find` takes. */
  pageMax: 100,
  /** People a page answers unless it asks for fewer. */
  pageDefault: 25,
  /** The longest search. */
  queryMaxLength: 100,
  /** The longest ID or cursor. */
  idMaxLength: 128,
} as const;

const id = v.string().min(1).max(peopleLimits.idMaxLength);
const name = v.string();
const email = v.string();
const team = v.object({ id, name });

/** A team, by ID and name. */
export type TeamRef = Infer<typeof team>;

const personCaller = v.object({
  kind: v.literal("person"),
  id,
  name,
  email,
  /** Their role in the organization. */
  orgRole: v.enum(["admin", "builder", "user"]),
  /** Their role in the App: a builder of it, or one of its users. */
  appRole: v.enum(["builder", "user"]),
  teams: v.array(team),
});

const visitorCaller = v.object({
  kind: v.literal("visitor"),
  /** Who owns what they insert: no member's ID is ever one. */
  id,
  email,
});

const caller = v.union(personCaller, visitorCaller);

/** A member of the organization calling the App. */
export type PersonCaller = Infer<typeof personCaller>;
/** Someone outside the organization the App was shared with. */
export type VisitorCaller = Infer<typeof visitorCaller>;
/** Who is calling: from core's verified identity, never from the client. */
export type Caller = Infer<typeof caller>;

const personSummary = v.object({ id, name, email });

const person = v.object({
  id,
  name,
  email,
  teams: v.array(team),
  /** Who they report to, when the organization's chart says; else null. */
  manager: personSummary.nullable(),
});

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
  caller: { args: v.object({}), returns: caller },
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

/** The names of the reads: who calls, and the directory's three. */
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
  caller: described("caller"),
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
    caller: "158b37a292bceef45df33dba25cd3530658b8baa704a561a0ad537f8b959396d",
    find: "ace640e0e7bee1ebf1c02822ecb8d45bd93ecbee26b9efc7984a251984dca7bb",
    search: "597a07e9e42a4a4ad6ac1f109aace57ce06d80be49d66140319af26b7e74a216",
    team: "607fe481310cd2f8bf74b57d5f0e93c7ba5620117d6d67dc5499476696dec554",
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
 * The references a screen reads through (`useCaller`, `usePeople`). They
 * name no App: the screen's page binds its calls to its own App, and core
 * answers them for that App and the person signed in there, whatever a
 * reference says. So they work in Grasp's own screens only; a portable
 * host reads the caller through one of the App's functions.
 */
export const peopleReferences = Object.freeze({
  caller: referenceTo("caller"),
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
 * The organization's people, read-only, for an App's members: never for a
 * visitor (`visitor.not_granted`). Each read answers at most 100.
 */
export interface PeopleDirectory {
  /** The people with these IDs (at most 100) who are members; others are left out. */
  readonly find: (ids: readonly string[]) => Promise<Person[]>;
  /** Members whose name or email holds `query`, by name. */
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
