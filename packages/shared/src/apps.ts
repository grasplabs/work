import { z } from "zod";

import { appLimits, appPathSegmentPattern } from "./app-limits.ts";
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

/** An App in the registry. Times are ISO 8601. */
export interface App {
  id: AppId;
  name: string;
  description: string;
  /** The user who created it. */
  owner: string;
  /**
   * What the App was made from: the blueprint's ID for an App made from
   * one, otherwise the label its creator gave, if any.
   */
  blueprint: string | null;
  /** The version that runs; null until one is made current. */
  currentVersion: number | null;
  /** The version up for review, if any. */
  pendingVersion: number | null;
  createdAt: string;
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
   * Makes a version the one that runs, after review or to roll back. By
   * anyone but one of the organization's admins (Grasp staff too, and a
   * rollback too), it asks again for the App's permissions on a
   * connection or to start a workflow: they allow
   * nothing until an admin grants them again, which approves the version
   * they reviewed (`PermissionsApi.grant`). Code of a version no admin approved changes
   * nothing, in a run that started on it too. Not for the first version
   * of an App created from a blueprint, made current for the first time:
   * it existed and was immutable when an admin granted its requests.
   */
  setCurrent: (app: string, version: number) => Promise<App>;
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

/** Someone an App is shared with. Times are ISO 8601. */
export interface AppMember extends AppMemberRef {
  /** The person's or team's name; null once they are gone. */
  name: string | null;
  role: AppRole;
  /** Who shared it with them, or last changed their role. */
  addedBy: string;
  addedAt: string;
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
}

/**
 * The App registry and each App's code. An App is open to its owner, the
 * organization's admins and the people and teams it is shared with
 * (`members`): its users call what its screens use, its builders the
 * rest.
 */
export interface AppsApi {
  create: (app: NewApp) => Promise<App>;
  /** The Apps the person has a role in, oldest first. */
  list: () => Promise<App[]>;
  get: (app: string) => Promise<App>;
  /** The screens and workflows of the App's current version. */
  contents: (app: string) => Promise<AppContents>;
  /**
   * The App's definition package: its current sealed release and the
   * workflow versions it binds, as portable source without secrets. For
   * its builders, never Grasp staff; audited.
   */
  definition: (app: string) => Promise<DefinitionPackage>;
  readonly files: AppFilesApi;
  readonly versions: AppVersionsApi;
  readonly members: AppMembersApi;
  readonly blueprints: AppBlueprintsApi;
}

/** Why a call to the App registry was refused. */
export const appErrors = defineErrorFamily({
  "app.invalid": "That isn't a valid request for an App.",
  "app.not_found": "There's no such App.",
  "app.member_invalid": "The App can't be shared with them like that.",
  "app.share_unreadable":
    "This App has read data they can't read where it comes from, such as someone else's mailbox or a collection they can't read, so it can't be shared with them.",
  "app.unreadable":
    "This App has read data you can't read where it comes from, so it isn't open to you. Ask whoever shared it.",
  "app.blueprint_not_found": "There's no such blueprint.",
  "app.version_not_found": "The App has no such version.",
  "app.too_large": "The App's files would be over its limits.",
  "app.nothing_to_commit": "The changes leave the latest version as it is.",
  "app.v1_server":
    "An App no longer has files under app/: its server code is app.ts, schema.ts and its functions in operations/. Delete the files under app/ and commit again.",
  "app.conflict": "Someone else changed this App at the same time. Try again.",
  "app.not_running": "The App has no current version to run yet.",
  "app.failed": "The App's server code failed.",
  "app.answer_invalid":
    "The App's server code answered with something other than plain data.",
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
