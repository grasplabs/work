import { z } from "zod";

import { appLimits, appPathSegmentPattern } from "./app-limits.ts";
import { businessProcessSchema } from "./business-processes.ts";
import type { BusinessProcess } from "./business-processes.ts";
import type { CatalogEntryRef } from "./connect.ts";
import type { DefinitionPackage } from "./definition-packages.ts";
import type { DiagnosticCategory } from "./diagnostics.ts";
import { defineErrorFamily } from "./errors.ts";
import { identifierSchema } from "./ids.ts";
import type { AppId, BlueprintId } from "./ids.ts";
import type { DeclaredPermission, Permission } from "./permissions.ts";
import { platformLimits } from "./platform-limits.ts";
import type { TriggerDeclaration } from "./workflows.ts";

// An App's code is a tree of text files, versioned as a whole: builders
// commit changes over the App's latest version as the next version; the
// chat's agent, for a builder, writes into a draft of its chat's own and
// proposes that. Versions never change once committed.
// One version is current, the one that runs; another can be pending, put
// up for review before a builder makes it current.

/**
 * A file's path in an App, relative to its root and `/`-separated, such
 * as `screens/inbox.tsx` or `operations/notes.ts`. No absolute paths, no empty,
 * `.` or `..` segments, no backslashes.
 */
export const appPathSchema = z
  .string()
  .min(1)
  .max(appLimits.pathLength)
  .refine(
    (path) => {
      const segments = path.split("/");
      return (
        segments.length <= appLimits.pathDepth &&
        segments.every((segment) => appPathSegmentPattern.test(segment)) &&
        // Files are keyed by path in plain objects: `__proto__` would be
        // the object's prototype, not a file.
        !Object.hasOwn(Object.prototype, path)
      );
    },
    {
      message: `A relative path of at most ${appLimits.pathDepth} names made of letters, digits, _, - and ., none starting with .`,
    }
  );

/** A version of an App: 1 for its first commit, then 2, 3, … */
export const appVersionSchema = z.int().min(1);

/** What a builder gives to create an App. */
export const newAppSchema = z.strictObject({
  name: z.string().trim().min(1).max(appLimits.nameLength),
  description: z.string().max(appLimits.descriptionLength).default(""),
  /**
   * A label for what the App was made from, as its creator gives it,
   * unchecked. An App made from a blueprint (`AppBlueprintsApi.create`)
   * gets the blueprint's ID instead.
   */
  blueprint: identifierSchema.optional(),
});
export type NewApp = z.input<typeof newAppSchema>;

/**
 * Changes to an App's files: a file's new content by path, or null to
 * delete it.
 */
export const fileChangesSchema = z
  .record(appPathSchema, z.string().max(appLimits.fileLength).nullable())
  .refine((changes) => Object.keys(changes).length > 0, {
    message: "At least one file",
  })
  .refine((changes) => Object.keys(changes).length <= appLimits.files, {
    message: `At most ${appLimits.files} files at once`,
  });
export type FileChanges = z.input<typeof fileChangesSchema>;

/** A commit message: what changed and why, for people. */
export const commitMessageSchema = z
  .string()
  .trim()
  .min(1)
  .max(appLimits.messageLength);

/**
 * Where an App is in its life: `draft` while its builders make it, open to
 * them alone; `published` once the people it is shared with may use it;
 * `archived` once put away, kept as it was and open to nobody until a
 * builder restores it, as a draft. Only a published App's triggers fire.
 */
export const appStatusSchema = z.enum(["draft", "published", "archived"]);
export type AppStatus = z.infer<typeof appStatusSchema>;

/** An App in the registry. Times are ISO 8601. */
export interface App {
  id: AppId;
  name: string;
  description: string;
  /**
   * The user who created it: always one of its builders, and whom its
   * triggered runs act for. It never changes; who answers for the App is
   * `responsible`.
   */
  owner: string;
  /**
   * The member who answers for the App: who is asked about it and decides
   * what changes (the prototype's "Owner"). Its owner until a builder names
   * someone else (`AppsApi.update`). It grants nothing: they are someone who
   * could open the App when named.
   */
  responsible: string;
  /**
   * The team or person the App is made for, if a builder said: shown with
   * it, granting nothing. Whom it is open to is its members.
   */
  audience: AppMemberRef | null;
  /**
   * What the App was made from: the blueprint's ID for an App made from
   * one, otherwise the label its creator gave, if any.
   */
  blueprint: string | null;
  /** The version that runs; null until one is made current. */
  currentVersion: number | null;
  /** The version up for review, if any. */
  pendingVersion: number | null;
  /** Where it is in its life (`appStatusSchema`). */
  status: AppStatus;
  /**
   * The business process it serves, if one was set: what the UI shows its
   * icon for and groups it by. It grants nothing.
   */
  process: BusinessProcess | null;
  createdAt: string;
}

/**
 * Why an integration is one of an App's: it holds a permission on a
 * connection to it, or a builder added it by hand.
 */
export type AppIntegrationReason = "permission" | "added";

/**
 * A catalog entry an App works with (`AppIntegrationsApi.list`): never
 * which connection, nor whose.
 */
export type AppIntegration = CatalogEntryRef & {
  /** Both, when it is added and held. */
  why: AppIntegrationReason[];
};

/**
 * The integrations an App works with: those it holds a permission on a
 * connection to, which its code asked for, and those its builders added
 * by hand for what it needs besides (`added`). Adding one grants nothing
 * and connects nothing: it is what the App is shown with until its code
 * asks for it.
 */
export interface AppIntegrationsApi {
  /** For anyone with a role in the App: catalog order is the page's. */
  list: (app: string) => Promise<AppIntegration[]>;
  /** Adds one by hand, for its builders; adding it again changes nothing. */
  add: (app: string, entry: CatalogEntryRef) => Promise<void>;
  /** Takes one added by hand off, for its builders; its permissions stay. */
  remove: (app: string, entry: CatalogEntryRef) => Promise<void>;
}

/** One committed version of an App. */
export interface AppVersion {
  app: AppId;
  version: number;
  /** The version it was committed on; null for the first. */
  parent: number | null;
  /** SHA-256 of the version's files, which identifies them exactly. */
  tree: string;
  files: number;
  /**
   * The user who committed it, or whom the chat's agent that wrote it
   * acted for (`proposedBy`).
   */
  author: string;
  /** What changed and why, in its author's words (the agent's, too). */
  message: string;
  createdAt: string;
  /** The chat's agent that wrote and proposed it; null for a person's. */
  proposedBy: AgentProposer | null;
}

/**
 * The chat's agent, as the one that wrote a version or asked for a
 * permission: the workspace agent, the person it acted for, and the chat
 * (in that person's Workspace object) it acted in.
 */
export interface AgentProposer {
  type: "agent";
  agentId: string;
  onBehalfOf: string;
  workspaceId: string;
  chatId: string;
  /** The build job of the chat that proposed it, when a job did. */
  jobId?: string;
}

/**
 * What an App's current version offers people: its screens by name (`inbox`
 * for `screens/inbox.tsx`) and its workflows by ID (`report` for
 * `workflows/report.ts`), each sorted. Empty while it has no current
 * version.
 */
export interface AppContents {
  /** The current version; null while it has none. */
  version: number | null;
  screens: string[];
  workflows: string[];
}

/** An App as `AppsApi.list` gives it, with its current version's contents. */
export interface AppOverview {
  app: ViewedApp;
  contents: AppContents;
}

/**
 * One screen of an App's current version (`AppsApi.screens`), with what
 * a list of screens shows of its App: its name, where it stands and the
 * business process it serves.
 */
export interface ListedScreen {
  app: Pick<App, "id" | "name" | "status" | "process">;
  /** The screen's name, as `AppContents.screens` gives it. */
  screen: string;
}

/** An App's files by path. */
export type AppFiles = Record<string, string>;

/** How a file differs between two versions. */
export type FileDiff =
  | { path: string; change: "added"; after: string }
  | { path: string; change: "deleted"; before: string }
  | { path: string; change: "modified"; before: string; after: string };

/** How something differs from the current version. */
export type ReviewChange = "added" | "modified" | "removed";

/**
 * What a version changes, as its reviewer reads it before making it
 * current (`AppVersionsApi.review`): worked out by core from the version
 * and the App as they are now, never written by whoever proposed it.
 */
export interface VersionReview {
  version: AppVersion;
  /**
   * The chat's agent that wrote it; null for a version a person
   * committed. `ownChat`: the reviewer is the person it acted for, who
   * alone gets the chat's title (a title may quote their question); null
   * for them once the chat is deleted.
   */
  proposedBy:
    | (AgentProposer & { ownChat: boolean; chatTitle: string | null })
    | null;
  /** What it is compared with: the current version; null while none is. */
  current: number | null;
  /** Its files that differ from the current version's, by path. */
  files: { path: string; change: ReviewChange }[];
  /**
   * How its server code (`app.ts`, `schema.ts`, `values.ts`,
   * `operations/` and `migrations/`, as its seal builds them) differs, if
   * it does: it runs as whoever uses the App, with every permission the
   * App holds. Its files that differ are `serverFiles`.
   */
  server: ReviewChange | null;
  serverFiles: { path: string; change: ReviewChange }[];
  /**
   * Its explicit migrations (spec 17.2) that the current version doesn't
   * have, or has otherwise (declared differently, or with server code
   * changed, which its transform may run), read from the App's manifest
   * wherever they are declared: each reads and rewrites every record of
   * its table, whoever owns it, once a release sealed on it runs on the
   * App's store. Null when its manifest can't be read (its code doesn't
   * build or inspect): it may then rewrite any table. Each says how many
   * fixtures it is run on as the version is sealed, and whether they all
   * passed (`fixturesPassed`), null until the version is sealed: one that
   * failed runs on no records, and the version can't be made current.
   */
  migrations:
    | {
        name: string;
        table: string;
        change: "added" | "modified";
        fixtures: number;
        fixturesPassed: boolean | null;
      }[]
    | null;
  /**
   * Its workflows that differ from the current version's: their own files,
   * or code outside `screens/` they may import (`shared`), such as the
   * server code their steps call.
   */
  workflows: {
    id: string;
    change: ReviewChange;
    /** The changed files outside screens and its own that it may use. */
    shared: string[];
    /**
     * Its steps that differ, by name, each compared as its code is
     * written: whether each may change something outside Grasp (it says
     * so, or it calls any of the App's bindings), and the App's bindings
     * its code calls (`APP`, a connection). While `shared` code changed, every step is listed
     * (`sharedCode`), as any may now behave differently through it, and
     * may change things if the workflow calls bindings at all; so is
     * every step while its own file changed outside its steps' calls (a
     * helper an option reads, say). Null when the code can't be read as
     * steps. Its runs are held to what each step calls, by binding, not
     * by method.
     */
    steps:
      | {
          name: string;
          change: ReviewChange;
          sideEffect: boolean;
          calls: string[];
          sharedCode: boolean;
          /**
           * Its options chosen at run time, not written in its
           * code (`StepOutline.dynamic`): a decision's reviewer from the
           * run's input, say. Absent when there are none.
           */
          dynamic?: string[];
        }[]
      | null;
    /**
     * Every one of the App's bindings its code calls, in any step: what
     * each step is held to when `steps` is null; none once it's removed.
     */
    calls: string[];
    /** Its parameters that differ, by name; null when they can't be read. */
    params: { name: string; change: ReviewChange }[] | null;
    /**
     * Its triggers added or removed, with how many of each (identical
     * triggers each register), and how many it had before and has after:
     * what makes it run on its own, such as a schedule, an event or mail
     * to an address; null when they can't be read.
     */
    triggers:
      | {
          trigger: TriggerDeclaration;
          change: "added" | "removed";
          count: number;
          countBefore: number;
          countAfter: number;
        }[]
      | null;
    /**
     * The workflow can change something outside Grasp: any of its steps,
     * changed or not, may, or its steps can't be read at all.
     */
    sideEffect: boolean;
  }[];
  /**
   * What the App asks for that no admin has granted yet: each waits for
   * an admin, whether the version is made current or not.
   */
  permissions: Permission[];
  /**
   * What the App holds now, which the version's code uses once current;
   * `askedAgain` for each that making it current would ask an admin for
   * again, as this reviewer can't grant it (`AppVersionsApi.setCurrent`).
   */
  grants: { permission: Permission; askedAgain: boolean }[];
  /**
   * Its workflows' tests: what making it current needs. Run once per
   * version's files, or taken from the check that proposed it.
   */
  tests: { status: "passed" | "failed" | "none"; failures: string[] };
}

/**
 * A problem a build found in an App's code: where it is, what found it,
 * how bad it is, and a fix when the check suggests one. What an agent
 * repairs from.
 */
export interface BuildDiagnostic {
  /** The App file; null when it is about the App as a whole. */
  file: string | null;
  /** 1-based; null when it is about the whole file. */
  line: number | null;
  /** 1-based, when the check knows it. */
  column?: number;
  /**
   * What found it: a TypeScript error code (`TS2322`), a lint rule
   * (`shadcn/no-restyle`), or a compiler stage (`imports`, `compile`).
   */
  rule?: string;
  /** What kind of problem it is, from a closed set (`diagnosticCategory`). */
  category: DiagnosticCategory;
  severity: "error" | "warning";
  message: string;
  /** A change that would fix it, when the check suggests one. */
  fix?: string;
}

/**
 * How one build of a saved version went:
 * - `ok`: built.
 * - `failed`: it doesn't build; `diagnostics` says why.
 * - `none`: the version has no files of this kind.
 * - `error`: the build couldn't run (the compiler unreachable or out of
 *   CPU) or didn't finish in time; `error` says so. It runs again at its
 *   first use.
 */
export interface SavedBuild {
  status: "ok" | "failed" | "none" | "error";
  diagnostics: BuildDiagnostic[];
  /** Why a build couldn't run, with `error`. */
  error?: string;
}

/** A committed version, with how its builds went (`AppFilesApi.commit`). */
export interface CommittedVersion extends AppVersion {
  builds: {
    screens: SavedBuild;
    workflows: SavedBuild;
  };
}

/** An App's files. */
export interface AppFilesApi {
  /**
   * The App's files at `version`; without one, at its latest version
   * (none while it has no version).
   */
  read: (app: string, version?: number) => Promise<AppFiles>;
  /**
   * Commits `changes` over the App's latest version as its next version,
   * and builds its screens and workflows, so the version opens without
   * building. Answers once they are done with how they went (`builds`).
   * A build never fails the commit. Files under `app/` (the v1 server's,
   * `appV1ServerFolder`) do: the commit is refused with `app.v1_server`,
   * naming them.
   * Changes that leave the files as they are: `app.nothing_to_commit`.
   * Of two commits at once, one is refused with `app.conflict`: read the
   * latest version and commit over it again.
   */
  commit: (
    app: string,
    changes: FileChanges,
    message: string
  ) => Promise<CommittedVersion>;
}

/** An App's versions and which of them runs. */
export interface AppVersionsApi {
  /** The App's versions, newest first, at most 100 from before `before`. */
  list: (app: string, before?: number) => Promise<AppVersion[]>;
  get: (app: string, version: number) => Promise<AppVersion>;
  /** How the files of `to` differ from those of `from`, by path. */
  diff: (app: string, from: number, to: number) => Promise<FileDiff[]>;
  /** Puts a version up for review. */
  propose: (app: string, version: number) => Promise<App>;
  /**
   * What a version changes against the current one (`VersionReview`),
   * for its builders to review before they make it current.
   */
  review: (app: string, version: number) => Promise<VersionReview>;
  /**
   * Makes a version the one that runs, after review or to roll back,
   * through a candidate verified for it (frozen, checked, built, sealed
   * and verified, then made current only over the version it was based
   * on). By
   * anyone but one of the organization's admins (Grasp staff too, and a
   * rollback too), it asks again for the App's permissions on a
   * connection or to start a workflow: they allow
   * nothing until an admin grants them again, which approves the version
   * they reviewed (`PermissionsApi.grant`). Code of a version no admin approved changes
   * nothing, in a run that started on it too. Not for the first version
   * of an App created from a blueprint, made current for the first time:
   * it existed and was immutable when an admin granted its requests.
   */
  setCurrent: (
    app: string,
    version: number,
    /**
     * The version the caller expects is current (null for none): refused
     * as `app.conflict` when another is. Without it, whichever is current
     * as the call begins.
     */
    expected?: number | null
  ) => Promise<App>;
}

/**
 * A role in one App: a `user` works in its screens; a `builder` also
 * changes its code, its settings and whom it is shared with. The person's
 * role in the organization is a ceiling: someone whose role there is
 * `user` never builds, whatever an App's members say.
 */
export const appRoleSchema = z.enum(["user", "builder"]);
export type AppRole = z.infer<typeof appRoleSchema>;

/** Whom an App is shared with: a person or a team of the organization. */
export const appMemberRefSchema = z.strictObject({
  type: z.enum(["person", "team"]),
  id: identifierSchema,
});
export type AppMemberRef = z.infer<typeof appMemberRefSchema>;

/** Sharing an App with someone, or changing their role in it. */
export const newAppMemberSchema = z.strictObject({
  ...appMemberRefSchema.shape,
  role: appRoleSchema,
});
export type NewAppMember = z.input<typeof newAppMemberSchema>;

/**
 * What a builder changes of an App's settings (`AppsApi.update`): any of
 * its name, description, who answers for it, whom it is made for (null
 * for nobody in particular), and the business process it serves (null for
 * none). At least one.
 */
export const appChangesSchema = z
  .strictObject({
    name: newAppSchema.shape.name.optional(),
    description: z.string().max(appLimits.descriptionLength).optional(),
    responsible: identifierSchema.optional(),
    audience: appMemberRefSchema.nullable().optional(),
    process: businessProcessSchema.nullable().optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, {
    message: "At least one setting",
  });
export type AppChanges = z.input<typeof appChangesSchema>;

/** Someone an App is shared with. Times are ISO 8601. */
export interface AppMember extends AppMemberRef {
  /** The person's or team's name; null once they are gone. */
  name: string | null;
  role: AppRole;
  /** Who shared it with them, or last changed their role. */
  addedBy: string;
  addedAt: string;
}

/** Someone who may answer for an App (`AppsApi.answerers`). */
export interface AppAnswerer {
  id: string;
  name: string;
}

/**
 * Whom an App is shared with. Apps are private: open to their owner
 * (always a builder, and not listed here), to the organization's admins,
 * who manage every App, and to the people and teams they are shared
 * with. Anyone with a role in the App lists them; its builders change
 * them.
 */
export interface AppMembersApi {
  list: (app: string) => Promise<AppMember[]>;
  /**
   * Shares the App, or changes the role of someone it is shared with.
   * Refused with `app.share_unreadable`, naming the `sources` and `people`
   * in its details, when the App has read data (from someone's personal
   * connection, or a collection they can't read) that anyone it would reach
   * can't read where it comes from.
   */
  add: (app: string, member: NewAppMember) => Promise<AppMember>;
  /**
   * Stops sharing the App with them. Their open screens of it stop at
   * once, or within a few seconds, as every push checks their role again.
   */
  remove: (app: string, member: AppMemberRef) => Promise<void>;
}

/**
 * Code to create Apps from: a version of an App its builders marked,
 * which whoever has a role in the App and builds creates from, or one the
 * release ships, which everyone who builds creates from. Times are
 * ISO 8601.
 */
export interface Blueprint {
  id: BlueprintId;
  /** Its App's name and description as it was marked. */
  name: string;
  description: string;
  /** The App and version it was marked from; null for a built-in. */
  app: AppId | null;
  version: number | null;
  /** Who marked it; null for a built-in. */
  markedBy: string | null;
  markedAt: string;
  /** What each App created from it asks for, each waiting for an admin. */
  permissions: DeclaredPermission[];
}

/** What a builder gives to create an App from a blueprint. */
export const fromBlueprintSchema = newAppSchema.pick({
  name: true,
  description: true,
});
export type FromBlueprint = z.input<typeof fromBlueprintSchema>;

/**
 * An App created from a blueprint: its first version holds the
 * blueprint's code, but for its AGENTS.md, a stub naming the
 * blueprint (the blueprint's was written from what its App read, which
 * the copy may not have read), and `permissions` are requests, waiting for
 * an admin, for what the blueprint declares (`Blueprint.permissions`).
 * Nothing else comes with it: no data, no settings, no runs, no members.
 */
export interface CreatedFromBlueprint {
  app: App;
  version: AppVersion;
  permissions: Permission[];
}

/**
 * A built-in blueprint's newer code, offered to an App created from it
 * (`AppBlueprintsApi.update`): merged, file by file, over the App's latest
 * version (`over`), from the blueprint's code the App last took (`from`)
 * to the blueprint's code now (`to`). A file only the blueprint changed
 * takes its change; one only the App's builders changed keeps theirs; one
 * both changed keeps theirs and is listed in `conflicts`. AGENTS.md is
 * the App's own. Nothing is written until a builder accepts it.
 */
export interface BlueprintUpdate {
  blueprint: string;
  from: string;
  to: string;
  over: number;
  /** How the merged files differ from version `over`'s. */
  changes: FileDiff[];
  /** Paths both changed, kept as the App has them, sorted. */
  conflicts: string[];
}

/** What a builder accepts of a `BlueprintUpdate`: exactly what they saw. */
export const acceptedUpdateSchema = z.strictObject({
  to: z.string().regex(/^[0-9a-f]{64}$/u),
  over: appVersionSchema,
});
export type AcceptedUpdate = z.input<typeof acceptedUpdateSchema>;

/** Blueprints: code to create Apps from. */
export interface AppBlueprintsApi {
  /**
   * The blueprints the person may see, newest first: those of the Apps
   * they have a role in, and, if they build, the built-ins.
   */
  list: () => Promise<Blueprint[]>;
  /** Marks a version of the App as a blueprint. Its builders. */
  mark: (app: string, version: number) => Promise<Blueprint>;
  /** Stops offering a blueprint. Its App's builders. */
  unmark: (blueprint: string) => Promise<void>;
  /** Creates an App of the person's own from a blueprint. */
  create: (
    blueprint: string,
    input: FromBlueprint
  ) => Promise<CreatedFromBlueprint>;
  /**
   * The newer code of the built-in the App was created from, merged over
   * its latest version; null when there is none. Its builders.
   */
  update: (app: string) => Promise<BlueprintUpdate | null>;
  /**
   * Commits the update the builder saw as the App's next version, which
   * is made current, as any, through a verified candidate. Its builders.
   */
  acceptUpdate: (app: string, accepted: AcceptedUpdate) => Promise<AppVersion>;
}

/**
 * The App registry and each App's code. An App is open to its owner, the
 * organization's admins and the people and teams it is shared with
 * (`members`): its users call what its screens use, its builders the
 * rest.
 */
/**
 * An App as the person asking lists or opens it, with their own role in
 * it, as core decides it for every call they make: a `builder` changes
 * it, a `user` works in it. A page offers changes only to its builders;
 * core refuses anyone else all the same. Grasp staff are builders of every
 * App here, as admins are, yet their sessions change none.
 */
export interface ViewedApp extends App {
  role: AppRole;
}

export interface AppsApi {
  create: (app: NewApp) => Promise<App>;
  /** The Apps the person has a role in, oldest first, each with that role. */
  list: () => Promise<ViewedApp[]>;
  get: (app: string) => Promise<ViewedApp>;
  /** The screens and workflows of the App's current version. */
  contents: (app: string) => Promise<AppContents>;
  /**
   * Every screen of the current version of each App the person has a role
   * in, as `list` finds the Apps and `contents` names the screens, in one
   * read: the newest App first, its screens by name.
   */
  screens: () => Promise<ListedScreen[]>;
  /**
   * The Apps `list` gives, each with what `contents` says of it, in one
   * read: the Domains page's cards.
   */
  overview: () => Promise<AppOverview[]>;
  /**
   * The App's definition package: its current sealed release and the
   * workflow versions it binds, as portable source without secrets. For
   * its builders, never Grasp staff; audited.
   */
  definition: (app: string) => Promise<DefinitionPackage>;
  /**
   * Publishes a draft for the people it is shared with, for its builders:
   * refused with `app.no_version` while no version of it is current, and
   * with `app.archived` once archived (restore it first). Audited; a
   * published App is answered as it is.
   */
  publish: (app: string) => Promise<App>;
  /**
   * Takes a published App back to a draft, for its builders: the people
   * it is shared with as users lose it, their open screens cleared.
   */
  unpublish: (app: string) => Promise<App>;
  /**
   * Archives the App, for its builders: nobody opens its screens or calls
   * it, its triggers stop, and its unfinished runs are cancelled, each
   * audited. Its data, members and grants are kept for `restore`.
   */
  archive: (app: string) => Promise<App>;
  /**
   * Restores an archived App, for its builders, as a draft: refused with
   * `app.stops_pending` while runs it started are still being stopped.
   */
  restore: (app: string) => Promise<App>;
  /**
   * Changes the App's settings (`AppChanges`), for its builders; audited
   * as `app.updated`. Naming who answers for it or whom it is made for is
   * not for Grasp staff: that is the client's decision. Refused with
   * `app.conflict` when someone changed the same settings since they were
   * read.
   */
  update: (app: string, changes: AppChanges) => Promise<App>;
  /**
   * Removes an archived App, for its owner or an admin of the organization,
   * never Grasp staff; audited as `app.removed`. Refused with
   * `app.remove_unarchived` until it is archived, and `app.stops_pending`
   * while runs it started are still being stopped. Its stores and their
   * records, and the workflows it doesn't own, stay; its grants, members
   * and bindings end. Afterwards it is answered as an App that isn't there.
   */
  remove: (app: string) => Promise<void>;
  /**
   * Who may answer for the App now, by ID and name (no email): each current
   * member of the organization core would accept as `responsible`, those
   * it is shared with through a team too. For whoever may name them: its
   * builders, never Grasp staff.
   */
  answerers: (app: string) => Promise<AppAnswerer[]>;
  readonly files: AppFilesApi;
  readonly versions: AppVersionsApi;
  readonly members: AppMembersApi;
  readonly blueprints: AppBlueprintsApi;
  readonly integrations: AppIntegrationsApi;
}

/**
 * The states of a candidate: one frozen version of an App on its way to
 * being made current (spec 22.1, core's app-candidates.ts). It moves
 * forward through `frozen`, `checking`, `building`, `verifying` and
 * `verified` to `active`, or ends in one of the outcomes: a defect a
 * repair can fix (`repairable_failed`), something outside the App's code
 * in the way (`operationally_blocked`), a refusal no repair of the code
 * changes (`rejected`), or a newer change by a person (`superseded`).
 * `active` and the outcomes are final; a repair is a new candidate.
 */
export const candidateStates = [
  "frozen",
  "checking",
  "building",
  "verifying",
  "verified",
  "active",
  "repairable_failed",
  "operationally_blocked",
  "rejected",
  "superseded",
] as const;
export type CandidateState = (typeof candidateStates)[number];

/** The states of a candidate still on its way: neither active nor ended. */
export const openCandidateStates = [
  "frozen",
  "checking",
  "building",
  "verifying",
  "verified",
] as const satisfies readonly CandidateState[];

/** Why a call to the App registry was refused. */
export const appErrors = defineErrorFamily({
  "app.invalid": "That isn't a valid request for a domain.",
  "app.not_found": "There's no such domain.",
  "app.member_invalid": "The domain can't be shared with them like that.",
  "app.responsible_invalid":
    "Only a member of the organization who can open the domain can answer for it.",
  "app.audience_invalid":
    "The domain can only be made for a member or a team of the organization.",
  "app.integrations_full":
    "The domain has as many integrations added as it may.",
  "app.share_unreadable":
    "This domain has read data they can't read where it comes from, such as someone else's mailbox or a collection they can't read, so it can't be shared with them.",
  "app.unreadable":
    "This domain has read data you can't read where it comes from, so it isn't open to you. Ask whoever shared it.",
  "app.blueprint_not_found": "There's no such blueprint.",
  "app.version_not_found": "The domain has no such version.",
  "app.too_large": "The domain's files would be over its limits.",
  "app.nothing_to_commit": "The changes leave the latest version as it is.",
  "app.v1_server":
    "A domain no longer has files under app/: its server code is app.ts, schema.ts and its functions in operations/. Delete the files under app/ and commit again.",
  "app.conflict":
    "Someone else changed this domain at the same time. Try again.",
  "app.candidate_busy":
    "This version is already being checked to be made current. Try again in a moment.",
  "app.candidate_attempts":
    "Checking this version to make it current failed too many times for reasons outside its code. Try again later.",
  "app.candidate_environment":
    "This version was checked by an earlier release of the platform, so it must be checked again before it's made current.",
  "app.candidate_release_changed":
    "This version's sealed release no longer matches the one that was checked, so it can't be made current. Make the change again to check it anew.",
  "app.candidate_superseded":
    "A newer change to this domain replaced this version's check before it finished. Make the version current again if you still want it.",
  "app.not_running": "The domain has no current version to run yet.",
  "app.no_version":
    "Make a version of the domain current before publishing it.",
  "app.archived": "The domain is archived. A builder can restore it.",
  "app.remove_unarchived": "Archive the domain before removing it.",
  "app.remove_forbidden":
    "Only the domain's owner or an admin of the organization removes it.",
  "app.stops_pending":
    "Runs the domain started are still being stopped from when it was archived. Try restoring it again in a few minutes.",
  "app.not_published":
    "The App isn't published, so other Apps and workflows can't call it.",
  "app.failed": "The domain's server code failed.",
  "app.answer_invalid":
    "The domain's server code answered with something other than plain data.",
  "app.checks_exhausted":
    "This draft failed its checks too many times in a row this turn, or its repairs have taken as long as they may. Stop, and tell the person what still fails.",
  "app.creates_exhausted":
    "This chat created as many Apps as one question may. Tell the person what you made.",
  "app.no_draft": "This chat has no draft of that App to preview.",
  "app.preview_outdated":
    "The draft changed since this preview loaded it. Load the preview again.",
  "app.preview_superseded":
    "A newer load of this preview replaced this one while it waited. The newer one shows the draft.",
  "app.preview_layout":
    "A preview runs only an App of spec 8's layout: app.ts and schema.ts, with its functions in operations/. This draft has no app.ts or schema.ts.",
  "app.preview_side_effect":
    "A preview changes nothing and reaches nothing outside it: no connections, no other Apps, no workflows and no writes to Knowledge.",
});

/**
 * The folder the v1 App server's code and exports were in (`app/server.ts`,
 * `app/exports.json`). Nothing reads it any more, so a commit holding a
 * file there is refused (`app.v1_server`).
 */
export const appV1ServerFolder = "app/";

/**
 * The limits of a sealed function's call of another App's through an app
 * resource. The input and the answer are JSON, measured in bytes of UTF-8
 * as sent: the function called is a public operation, held to spec 18.1's
 * input and output limits as any other is. One call may lead to more (the called App calling another), at most
 * `depth` calls deep, so 3 hops, 4 Apps: A calls B, B calls C, C calls D,
 * and D calls no further. Never back into an App already in it; all of
 * them end by the time the first one must. Through app resources, all the
 * calls one call leads to, down every branch, are at most `calls`.
 */
export const appCallLimits = {
  inputBytes: platformLimits.operationInputBytes,
  answerBytes: platformLimits.operationOutputBytes,
  depth: 3,
  calls: 32,
} as const;
