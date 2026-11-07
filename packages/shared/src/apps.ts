import { z } from "zod";

import type { AppDataApi } from "./app-data.ts";
import { appLimits, appPathSegmentPattern } from "./app-limits.ts";
import type { AppVisitorEntry, AppVisitorGrants } from "./app-visitors.ts";
import type { AppWebhooksApi } from "./app-webhooks.ts";
import { businessProcessSchema } from "./business-processes.ts";
import type { BusinessProcess } from "./business-processes.ts";
import type { CatalogEntryRef } from "./connect.ts";
import type { DefinitionPackage } from "./definition-packages.ts";
import type { DiagnosticCategory } from "./diagnostics.ts";
import { defineErrorFamily } from "./errors.ts";
import { identifierSchema } from "./ids.ts";
import type { AppId, BlueprintId } from "./ids.ts";
import type { DeclaredPermission, Permission } from "./permissions.ts";

// An App's code is a tree of text files, versioned as a whole: builders
// commit changes over the App's latest version as the next version; the
// chat's agent, for a builder, writes into a draft of its chat's own and
// proposes that. Versions never change once committed.
// One version is current, the one that runs; another can be pending, put
// up for review before a builder makes it current.

/**
 * A file's path in an App, relative to its root and `/`-separated, such
 * as `src/routes/inbox.tsx` or `server/notes.ts`. No absolute paths, no empty,
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
        !Object.hasOwn(Object.prototype, path) &&
        // The modules Grasp generates for an App, as Convex's
        // `_generated/`: never one of its own files.
        !path.startsWith("server/_generated/")
      );
    },
    {
      message: `A relative path of at most ${appLimits.pathDepth} names made of letters, digits, _, - and ., none starting with ., and never under server/_generated/, which Grasp generates`,
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
  audience: AppAudience | null;
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
   * The last part of the App's own address under the workspace's
   * (`appLinkSchema`), which opens it for whoever may use it while it is
   * published; null while its builders gave it none.
   */
  link: string | null;
  /**
   * The business process it serves, if one was set: what the UI shows its
   * icon for and groups it by. It grants nothing.
   */
  process: BusinessProcess | null;
  createdAt: string;
}

/** The longest an App's link may be, in characters. */
export const appLinkMaxLength = 48;

/**
 * Every address's first part the workspace already has, its pages' and
 * core's own: no App's link may take one, so a link never stands for a
 * page, nor a page for a link. Each new top-level page joins it, which
 * its test holds the web app's routes to (web's app-own-links.test.ts).
 */
export const reservedAppLinks: ReadonlySet<string> = new Set([
  "activity",
  "api",
  "apps",
  "assets",
  "brain",
  "chat",
  "chat-link",
  "connect-microsoft",
  "connections",
  "dashboard",
  "decisions",
  "guest",
  "inbox",
  "integrations",
  "interview",
  "kit",
  "knowledge",
  "links",
  "members",
  "models",
  "notifications",
  "onboarding",
  "package-artifacts",
  "projects",
  "rpc",
  "page-frame",
  "page-modules",
  "settings",
  "setup",
  "sign-in",
  "staff",
  "workflows",
]);

/**
 * An App's link, the last part of its address: lower-case letters and
 * digits, single dashes between them, at most {@link appLinkMaxLength},
 * and none the workspace already has (`reservedAppLinks`).
 */
export const appLinkSchema = z
  .string()
  .max(appLinkMaxLength)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
  .refine((link) => !reservedAppLinks.has(link), {
    message: "The workspace has a page at that address.",
  });

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
}

/**
 * What an App's current version offers people: whether it has pages to
 * open (file routes under `src/routes/`). None while it has no current
 * version.
 */
export interface AppContents {
  /** The current version; null while it has none. */
  version: number | null;
  pages: boolean;
}

/** An App as `AppsApi.list` gives it, with its current version's contents. */
export interface AppOverview {
  app: ViewedApp;
  contents: AppContents;
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

/** One row rule, as a version's review shows it (`VersionReview.rowRules`). */
export type ReviewedRowRule =
  | { kind: "owner" }
  | { kind: "person"; field: string }
  | { kind: "team"; field: string }
  | { kind: "role"; role: "builder" | "user" };

/** A table's row rules, as a version's review shows them. */
export interface TableRowRules {
  table: string;
  read: ReviewedRowRule[] | null;
  write: ReviewedRowRule[] | null;
}

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
   * How its server code (`grasp.config.ts`, `values.ts`,
   * `server/`, as its seal builds them) differs, if
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
   * Whether its server code may hand files people can read to the
   * workflows it binds (GRA-976): it declares a files resource with
   * `read` and a bound workflow whose input can hold a file. Its
   * pages' and server code's starts then copy the person's file into
   * the run, as they may read it. Null when its manifest can't be read.
   */
  handsFilesToWorkflows: boolean | null;
  /**
   * Whether its server code and pages read the organization's people
   * (`permissions: { people: true }`, GRA-1474): every member's name, email and
   * teams, for whoever uses it. No admin approves it; its reviewer sees
   * it. Null when its manifest can't be read.
   */
  readsPeople: boolean | null;
  /**
   * Who sees and changes which rows of its tables, for each table that
   * declares row rules (`defineTable(...).access`, GRA-1482). `read`: its
   * read rules, or null for reading left to the table's access mode.
   * `write`: who changes its rows, as the store holds a write: its write
   * rules; without them its read rules (for a write mode that reaches
   * every row) or the owner (for an `owner` mode), each of the rows they
   * can read too; null when nobody writes them (a `none` mode). A row
   * reaches whoever any of a direction's rules admits. Null when its
   * manifest can't be read.
   */
  rowRules: TableRowRules[] | null;
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
   * (`no-debugger`), a class check (`design/no-restyle`), or a compiler
   * stage (`imports`, `compile`).
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
  /**
   * Why a build couldn't run, with `error`; or why pages were checked
   * only in part (`standIn`).
   */
  error?: string;
  /**
   * Pages checked against stand-ins for the references their server code
   * generates, because it doesn't build or register: never `ok` (`error`
   * when nothing else failed, `failed` when something did), with why in
   * `error`. Check again once the server code registers.
   */
  standIn?: true;
}

/** A committed version, with how its builds went (`AppFilesApi.commit`). */
export interface CommittedVersion extends AppVersion {
  builds: {
    pages: SavedBuild;
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
   * and builds its pages, so the version opens without building.
   * Answers once they are done with how they went (`builds`).
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

/** Why an admin revokes a release or holds it: kept in the audit log. */
const releaseReasonSchema = z.string().trim().min(1).max(500);

/** Revoking an App's release (`AppVersionsApi.revoke`): why. */
export const releaseRevocationSchema = z.strictObject({
  reason: releaseReasonSchema,
});
export type ReleaseRevocation = z.input<typeof releaseRevocationSchema>;

/**
 * A legal hold on an App's release (`AppVersionsApi.placeHold`): its name,
 * such as a case reference, which lifting it names again, and why.
 */
export const releaseHoldSchema = z.strictObject({
  hold: identifierSchema,
  reason: releaseReasonSchema,
});
export type ReleaseHold = z.input<typeof releaseHoldSchema>;

/** A legal hold that keeps a release, until an admin lifts it. */
export interface AppReleaseHold {
  hold: string;
  placedAt: string;
}

/**
 * A sealed release of one of an App's versions (spec 16.3), as its admins
 * keep it: whether it was revoked, so it runs no more, and the legal
 * holds that keep it.
 */
export interface AppRelease {
  app: AppId;
  version: number;
  /** SHA-256 of its manifest, which names its code exactly. */
  manifestHash: string;
  sealedAt: string;
  /** When an admin revoked it; null while it may run. */
  revokedAt: string | null;
  /** Its legal holds, oldest first. */
  holds: AppReleaseHold[];
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
   * publishing it first if it isn't yet (built, sealed and its tests run),
   * then made current only over the version current as it began. By
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
  /**
   * The App's sealed releases, newest first, at most 100 from before
   * `before`, with whether each was revoked and its legal holds. For the
   * organization's own admins, never Grasp staff, as is each call below.
   */
  releases: (app: string, before?: number) => Promise<AppRelease[]>;
  /**
   * Revokes a sealed release (`releaseRevocationSchema`): it runs no more,
   * calls already running included, and is kept for good. Audited, with
   * why; revoking it again changes nothing.
   */
  revoke: (app: string, version: number, input: unknown) => Promise<AppRelease>;
  /**
   * Places a legal hold on a sealed release (`releaseHoldSchema`): it is
   * kept until the hold is lifted, however old. Audited, with why; placing
   * the same hold again changes nothing.
   */
  placeHold: (
    app: string,
    version: number,
    input: unknown
  ) => Promise<AppRelease>;
  /** Lifts legal hold `hold` from a release. Audited. */
  releaseHold: (
    app: string,
    version: number,
    hold: string
  ) => Promise<AppRelease>;
}

/**
 * A role in one App: a `user` works in its pages; a `builder` also
 * changes its code, its settings and whom it is shared with. The person's
 * role in the organization is a ceiling: someone whose role there is
 * `user` never builds, whatever an App's members say.
 */
export const appRoleSchema = z.enum(["user", "builder"]);
export type AppRole = z.infer<typeof appRoleSchema>;

/**
 * Whom an App is shared with: a person or a team of the organization, or
 * everyone in a project (@grasp-os/shared/projects).
 */
export const appMemberRefSchema = z.strictObject({
  type: z.enum(["person", "team", "project"]),
  id: identifierSchema,
});
export type AppMemberRef = z.infer<typeof appMemberRefSchema>;

/** Whom an App is made for: a person or a team of the organization. */
export const appAudienceSchema = z.strictObject({
  type: z.enum(["person", "team"]),
  id: identifierSchema,
});
export type AppAudience = z.infer<typeof appAudienceSchema>;

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
    audience: appAudienceSchema.nullable().optional(),
    process: businessProcessSchema.nullable().optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, {
    message: "At least one setting",
  });
export type AppChanges = z.input<typeof appChangesSchema>;

/** Someone an App is shared with. Times are ISO 8601. */
export interface AppMember extends AppMemberRef {
  /**
   * The person's, team's or project's name; null once they are gone, and
   * for a project the person isn't in, whose name is its members' alone.
   */
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
   * Stops sharing the App with them. Their open pages of it stop at
   * once, or within a few seconds, as every push checks their role again.
   */
  remove: (app: string, member: AppMemberRef) => Promise<void>;
  /**
   * Whom its builders may share the App with: the organization's people
   * and teams, by name and ID alone (no address, no role, no team's
   * members). For whoever may share it (`add`).
   */
  candidates: (app: string) => Promise<ShareCandidates>;
}

/**
 * The organization's people and teams, by name, to share an App with, and
 * the projects the person builds, whose everyone it may be shared with.
 */
export interface ShareCandidates {
  people: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  projects: { id: string; name: string }[];
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
   * is published and made current as any. Its builders.
   */
  acceptUpdate: (app: string, accepted: AcceptedUpdate) => Promise<AppVersion>;
}

/**
 * The App registry and each App's code. An App is open to its owner, the
 * organization's admins and the people and teams it is shared with
 * (`members`): its users call what its pages use, its builders the
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
  /** The pages and workflows of the App's current version. */
  contents: (app: string) => Promise<AppContents>;
  /**
   * The Apps `list` gives, each with what `contents` says of it, in one
   * read: the Apps page's tiles, each App's pages its pages.
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
   * Gives the App its own link (`appLinkSchema`), or takes it off with
   * `null`, for its builders: refused with `app.link_taken` when another
   * App has it, and `app.invalid_link` for one it can't be. Audited. The
   * link opens the App only while it is published.
   */
  setLink: (app: string, link: string | null) => Promise<App>;
  /**
   * The App link `link` opens, for the person: only one that is published
   * and that they may use; any other is answered as no App at all
   * (`app.not_found`), so a link tells nothing of an App they can't open.
   */
  openLink: (link: string) => Promise<{ app: AppId }>;
  /**
   * Who may open the App without being a member (`@grasp-os/shared/app-
   * visitors`): the addresses and domains its builders listed. For its
   * builders.
   */
  visitors: (app: string) => Promise<AppVisitorEntry[]>;
  /**
   * Sets who may open the App without being a member, the whole list at
   * once, for its builders: `visitor.invalid` for an address or domain it
   * can't be, or more than 50. Audited. Whoever leaves the list can't open
   * it from their next request on.
   */
  setVisitors: (
    app: string,
    list: AppVisitorEntry[]
  ) => Promise<AppVisitorEntry[]>;
  /**
   * The functions the App's current version grants its visitors, by path,
   * for its builders: visitors call these as the App itself, and nothing
   * else.
   */
  visitorGrants: (app: string) => Promise<AppVisitorGrants>;
  /**
   * Grants visitors these functions of the App's current version, the
   * whole set at once, for its builders: public queries and mutations
   * only (`visitor.invalid` otherwise). Audited. A version starts with
   * none, and taking one away stops calls already running before they
   * commit.
   */
  setVisitorGrants: (
    app: string,
    functions: string[]
  ) => Promise<AppVisitorGrants>;
  /**
   * Takes a published App back to a draft, for its builders: the people
   * it is shared with as users lose it, their open pages cleared.
   */
  unpublish: (app: string) => Promise<App>;
  /**
   * Archives the App, for its builders: nobody opens its pages or calls
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
  readonly webhooks: AppWebhooksApi;
  readonly data: AppDataApi;
}

/** Why a call to the App registry was refused. */
export const appErrors = defineErrorFamily({
  "app.invalid": "That isn't a valid request for an App.",
  "app.not_found": "There's no such App.",
  "app.member_invalid": "The App can't be shared with them like that.",
  "app.responsible_invalid":
    "Only a member of the organization who can open the App can answer for it.",
  "app.audience_invalid":
    "The App can only be made for a member or a team of the organization.",
  "app.integrations_full": "The App has as many integrations added as it may.",
  "app.share_unreadable":
    "This App has read data they can't read where it comes from, such as someone else's mailbox or a collection they can't read, so it can't be shared with them.",
  "app.unreadable":
    "This App has read data you can't read where it comes from, so it isn't open to you. Ask whoever shared it.",
  "app.blueprint_not_found": "There's no such blueprint.",
  "app.version_not_found": "The App has no such version.",
  "app.too_large": "The App's files would be over its limits.",
  "app.nothing_to_commit": "The changes leave the latest version as it is.",
  "app.v1_server":
    "An App no longer has files under app/: its server code is grasp.config.ts, server/schema.ts and its functions in server/. Delete the files under app/ and commit again.",
  "app.layout_missing":
    "Every version of an App holds grasp.config.ts and server/schema.ts, which Grasp generates from its definition.json. Restore definition.json, or change the definition with the definition tools, and commit again.",
  "app.conflict": "Someone else changed this App at the same time. Try again.",
  "app.not_running": "The App has no current version to run yet.",
  "app.no_version": "Make a version of the App current before publishing it.",
  "app.link_taken": "Another App has that link. Choose another.",
  "app.invalid_link":
    "A link is lower-case letters and digits with single dashes between them, at most 48, and none the workspace already has a page at.",
  "app.archived": "The App is archived. A builder can restore it.",
  "app.remove_unarchived": "Archive the App before removing it.",
  "app.remove_forbidden":
    "Only the App's owner or an admin of the organization removes it.",
  "app.stops_pending":
    "Runs the App started are still being stopped from when it was archived. Try restoring it again in a few minutes.",
  "app.not_published":
    "The App isn't published, so other Apps and workflows can't call it.",
  "app.failed": "The App's server code failed.",
  "app.answer_invalid":
    "The App's server code answered with something other than plain data.",
  "app.creates_exhausted":
    "This chat created as many Apps as one question may. Tell the person what you made.",
  "app.no_workflows":
    "An App holds no workflows of its own, nor code under workflows/. Build an independent workflow with env.workflowBuild, add it to the App's permissions with addPermission (permission.workflow) and bind it to the App under that alias.",
  "app.generated_file":
    "definition.json, grasp.config.ts and server/schema.ts are the App's definition and the code Grasp generates from it: change them with the definition tools (addTable, addField, changeField, renameField, setAccess, addIndex, addPermission and their remove counterparts, and the preference tools), never by writing them.",
  "app.definition_invalid":
    "The App's definition.json, from which its grasp.config.ts and server/schema.ts are generated, is missing or isn't valid.",
  "app.chat_has_app":
    "This chat is an App's own chat: it changes that App, whose ID the chat gives, and creates no other. Change its files with readFile, writeFile and editFile; for another App, the person starts one from New App.",
  "app.draft_failed":
    "The changes don't pass their checks yet. Ask Grasp in the chat to fix them, then publish.",
  "app.not_in_chat":
    "This chat neither changes that App nor is its chat, so it has no preview of it.",
  "app.preview_outdated":
    "The draft changed since this preview loaded it. Load the preview again.",
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
 * The most an App's error carries to its caller besides its code (its
 * details: the version, the method and the App's own message), as UTF-8
 * JSON, in bytes. The App's message is cut to fit, never sent whole: an
 * error reaches a page, which is held to what it may receive whatever
 * the App throws.
 */
export const appErrorDetailsBytes = 16 * 1024;
