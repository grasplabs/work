import { z } from "zod";

import type { AppDataApi } from "./app-data.ts";
import { appLimits, appPathSegmentPattern } from "./app-limits.ts";
import type { AppReview, AppPreviewApi } from "./app-review.ts";
import type { AppVisitorEntry, AppVisitorGrants } from "./app-visitors.ts";
import type { AppWebhooksApi } from "./app-webhooks.ts";
import { businessProcessSchema } from "./business-processes.ts";
import type { BusinessProcess } from "./business-processes.ts";
import type { CatalogEntryRef } from "./connect.ts";
import type { DataModelChange, DraftDataModel } from "./data-model.ts";
import type { DefinitionPackage } from "./definition-packages.ts";
import type { DiagnosticCategory } from "./diagnostics.ts";
import { defineErrorFamily } from "./errors.ts";
import { identifierSchema } from "./ids.ts";
import type { AppId, BlueprintId } from "./ids.ts";
import type { DeclaredPermission, Permission } from "./permissions.ts";

// An App's code is a tree of text files, versioned as a whole. Builders
// and their chats' agents write into the App's one shared draft; a builder
// publishes it, which makes it the App's next version and live in one
// step. Versions never change once committed, and one is live: the one
// that runs.

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
        // `_generated/`: never one of its own files, in any case (an
        // App's paths never differ only in case).
        !`${path.toLowerCase()}/`.startsWith("server/_generated/")
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
  /**
   * The live version, the one that runs; null until its first publish.
   * Until then the App is open to its builders alone; from then on to
   * everyone it is shared with too.
   */
  currentVersion: number | null;
  /** The live version's label (`AppVersion.label`); null while none is live. */
  liveLabel: string | null;
  /**
   * Whether a builder archived it: kept as it was, open to nobody and
   * running nothing until a builder restores it.
   */
  archived: boolean;
  /**
   * The last part of the App's own address under the workspace's
   * (`appLinkSchema`), which opens it for whoever may use it while it is
   * live; null while its builders gave it none.
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
  "agents",
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
  /** What it is a version of, as drafts and versions name it. */
  kind: "app";
  app: AppId;
  /** Its ID within the App, counting up from 1. */
  version: number;
  /**
   * What people call it, `YY.MM.N` (@grasp-os/shared/release-id): given
   * the first time it goes live, and kept; null for one never live.
   */
  label: string | null;
  /** The version it was committed on; null for the first. */
  parent: number | null;
  /** SHA-256 of the version's files, which identifies them exactly. */
  tree: string;
  files: number;
  /** The user who published it, or committed it. */
  author: string;
  /** What changed and why, in its author's words. */
  message: string;
  createdAt: string;
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

/** One row rule, as a draft's changes show it (`AppReview.rowRules`). */
export type ReviewedRowRule =
  | { kind: "owner" }
  | { kind: "person"; field: string }
  | { kind: "team"; field: string }
  | { kind: "role"; role: "builder" | "user" };

/** A table's row rules, as a draft's changes show them. */
export interface TableRowRules {
  table: string;
  read: ReviewedRowRule[] | null;
  write: ReviewedRowRule[] | null;
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
   * with `definition` (@grasp-os/runtime's `AppDefinition`, checked whole:
   * `app.definition_invalid` otherwise) if given, else the latest
   * version's, and builds its pages, so the version opens without
   * building. Its `grasp.config.ts` and `server/schema.ts` are always
   * what its definition generates, whatever `changes` hold of them.
   * Answers once they are done with how they went (`builds`).
   * A build never fails the commit.
   * Changes that leave the files and the definition as they are:
   * `app.nothing_to_commit`.
   * Of two commits at once, one is refused with `app.conflict`: read the
   * latest version and commit over it again.
   */
  commit: (
    app: string,
    changes: FileChanges,
    message: string,
    definition?: unknown
  ) => Promise<CommittedVersion>;
}

/** Why an admin revokes a release or holds it: kept in the audit log. */
const releaseReasonSchema = z.string().trim().min(1).max(500);

/** Revoking an App's release (`AppReleasesApi.revoke`): why. */
export const releaseRevocationSchema = z.strictObject({
  reason: releaseReasonSchema,
});
export type ReleaseRevocation = z.input<typeof releaseRevocationSchema>;

/**
 * A legal hold on an App's release (`AppReleasesApi.placeHold`): its name,
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

/**
 * An App's sealed releases (`apps.releases`): for the organization's own
 * admins, never Grasp staff, as is each call below.
 */
export interface AppReleasesApi {
  /**
   * The App's sealed releases, newest first, at most 100 from before
   * `before`, with whether each was revoked and its legal holds.
   */
  list: (app: string, before?: number) => Promise<AppRelease[]>;
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
 * both changed keeps theirs and is listed in `conflicts`. The App's
 * definition merges as a whole the same way (`definition`, the SHA-256 of
 * the blueprint's now; `definitionConflict` when both changed it), and
 * its config and schema follow it. AGENTS.md is the App's own. Nothing is
 * written until a builder accepts it.
 */
export interface BlueprintUpdate {
  blueprint: string;
  from: string;
  to: string;
  /** The SHA-256 of the blueprint's definition now, which `to` goes with. */
  definition: string;
  over: number;
  /** How the merged files differ from version `over`'s. */
  changes: FileDiff[];
  /** Paths both changed, kept as the App has them, sorted. */
  conflicts: string[];
  /**
   * Whether both changed the definition, each otherwise: the App's is
   * kept, whether or not the code generated from the two differs (a
   * change of stable IDs alone changes none).
   */
  definitionConflict: boolean;
}

/** What a builder accepts of a `BlueprintUpdate`: exactly what they saw. */
export const acceptedUpdateSchema = z.strictObject({
  to: z.string().regex(/^[0-9a-f]{64}$/u),
  definition: z.string().regex(/^[0-9a-f]{64}$/u),
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
  /**
   * Creates an App of the person's own from a blueprint; with `project`,
   * in that project, as `chats.newApp` makes one.
   */
  create: (
    blueprint: string,
    input: FromBlueprint,
    project?: string
  ) => Promise<CreatedFromBlueprint>;
  /**
   * The newer code of the built-in the App was created from, merged over
   * its latest version; null when there is none. Its builders.
   */
  update: (app: string) => Promise<BlueprintUpdate | null>;
  /**
   * Commits the update the builder saw as the App's next version, which
   * a builder then makes live (`VersionsApi.rollback`). Its builders.
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
   * Gives the App its own link (`appLinkSchema`), or takes it off with
   * `null`, for its builders: refused with `app.link_taken` when another
   * App has it, and `app.invalid_link` for one it can't be. Audited. The
   * link opens the App only while it is live.
   */
  setLink: (app: string, link: string | null) => Promise<App>;
  /**
   * The App link `link` opens, for the person: only one that is live
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
   * Archives the App, for its builders: nobody opens its pages or calls
   * it, its triggers stop, and its unfinished runs are cancelled, each
   * audited. Its data, members and grants are kept for `restore`.
   */
  archive: (app: string) => Promise<App>;
  /**
   * Resets every record of an App for good, for the organization's
   * admins, never Grasp staff nor builders, confirmed by the App's `name`
   * as it is now (`app.reset_name_mismatch`). Its current version's
   * schema is applied to the empty store in the same transaction.
   * Audited as `store.reset`, with how many records each table held.
   */
  resetData: (app: string, name: string) => Promise<void>;
  /**
   * Restores an archived App, for its builders: refused with
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
  /**
   * What publishing the App's draft would change against its live
   * version, and whether its checks pass (`AppReview`), to review
   * before publishing it at the revision this names (`DraftsApi.publish`).
   */
  review: (app: string) => Promise<AppReview>;
  /**
   * The data model of the App's draft, from its definition, and what
   * publishing the draft does to the App's records.
   */
  dataModel: (app: string) => Promise<DraftDataModel>;
  /**
   * Changes the definition in the App's draft by `operation` (an
   * operation of `@grasp-os/sdk/definition`, or a few made as one): the
   * model after it, the plan, and what this change alone does
   * (`change`), or the problem, which changed nothing. With `preview`,
   * nothing is saved: what it would do, to show first. Not for an
   * archived App.
   */
  define: (
    app: string,
    operation: unknown,
    preview?: boolean
  ) => Promise<DataModelChange>;
  readonly files: AppFilesApi;
  readonly releases: AppReleasesApi;
  readonly members: AppMembersApi;
  readonly blueprints: AppBlueprintsApi;
  readonly integrations: AppIntegrationsApi;
  readonly webhooks: AppWebhooksApi;
  readonly data: AppDataApi;
  readonly preview: AppPreviewApi;
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
  "app.conflict": "Someone else changed this App at the same time. Try again.",
  "app.not_running": "The App has no current version to run yet.",
  "app.link_taken": "Another App has that link. Choose another.",
  "app.invalid_link":
    "A link is lower-case letters and digits with single dashes between them, at most 48, and none the workspace already has a page at.",
  "app.archived": "The App is archived. A builder can restore it.",
  "app.remove_unarchived": "Archive the App before removing it.",
  "app.publish_unfinished":
    "This version's data model reached the App's data, but the version couldn't be made current, and the current version's data model can't be put back. Publish this version again to finish it.",
  "app.reset_name_mismatch":
    "Type the App's name exactly as it is to reset its data.",
  "app.remove_forbidden":
    "Only the App's owner or an admin of the organization removes it.",
  "app.stops_pending":
    "Runs the App started are still being stopped from when it was archived. Try restoring it again in a few minutes.",
  "app.failed": "The App's server code failed.",
  "app.answer_invalid":
    "The App's server code answered with something other than plain data.",
  "app.no_workflows":
    "An App holds no workflows of its own, nor code under workflows/. Build an independent workflow with env.workflowBuild, add it to the App's permissions with addPermission (permission.workflow) and bind it to the App under that alias.",
  "app.generated_file":
    "grasp.config.ts and server/schema.ts are the code Grasp generates from the App's definition, which is no file: change it with the definition tools (addTable, addField, changeField, renameField, renameTable, setAccess, addIndex, addPermission, renameFunction and their remove counterparts), never by writing them.",
  "app.definition_invalid":
    "The App's definition, from which its grasp.config.ts and server/schema.ts are generated, isn't valid.",
  "app.draft_failed":
    "The changes don't pass their checks yet. Ask Grasp in the chat to fix them, then publish.",
  "app.preview_outdated":
    "The draft changed since this preview loaded it. Load the preview again.",
  "app.preview_side_effect":
    "A preview changes nothing and reaches nothing outside it: no connections, no other Apps, no workflows and no writes to Knowledge.",
});

/**
 * The most an App's error carries to its caller besides its code (its
 * details: the version, the method and the App's own message), as UTF-8
 * JSON, in bytes. The App's message is cut to fit, never sent whole: an
 * error reaches a page, which is held to what it may receive whatever
 * the App throws.
 */
export const appErrorDetailsBytes = 16 * 1024;
