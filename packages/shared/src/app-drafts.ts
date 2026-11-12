import type { AppDataPage, AppDataTable } from "./app-data.ts";
import type {
  App,
  AppFiles,
  FileDiff,
  ReviewChange,
  TableRowRules,
} from "./apps.ts";
import type {
  PreviewAt,
  PreviewBundle,
  PreviewShown,
  PreviewUpdate,
} from "./chat.ts";
import type {
  DataModelChange,
  DefinitionPlan,
  DraftDataModel,
} from "./data-model.ts";
import type { AppId } from "./ids.ts";
import type { PageProblem, SubscriptionApi } from "./pages.ts";
import type { Permission } from "./permissions.ts";

// An App's draft (core's app-drafts.ts): one per App, shared by everyone
// who builds it and by the agents of their chats. Every write lands in it
// over the revision it read, so a stale one is refused and rereads; each
// agent turn and each person's edit keeps an undo point.

/** An App's draft as it is now (`AppDraftsApi.get`). */
export interface AppDraft {
  app: AppId;
  /** The version it is over; null for an App with none yet. */
  base: number | null;
  /** The paths it changes, sorted. */
  changed: string[];
  /** Those of `changed` it deletes, sorted: nothing to open or preview. */
  deleted: string[];
  /**
   * Whether it changes the App's definition: a change of its stable IDs
   * alone changes no file, yet is a change of the App all the same.
   */
  definitionChanged: boolean;
  /** Which write of the draft this is (0: none yet): a preview of an earlier one is out of date. */
  revision: number;
  /** When it was last written (ISO 8601); null before its first write. */
  updatedAt: string | null;
  /** Who wrote it last, themselves or through their chat's agent; null before its first write. */
  updatedBy: string | null;
}

/**
 * One undo point of an App's draft (`AppDraftsApi.points`): the draft as
 * one agent turn left it, as one person's edit left it, or as a restore
 * made it. The newest follows its turn's writes while the turn runs, then
 * never changes; it is restored only as a new one.
 */
export interface AppDraftPoint {
  /** Its place among the draft's points, from 1, in the order they landed. */
  number: number;
  /** The draft's revision it made: its preview's calls name it. */
  revision: number;
  /** The version of the App it is over; null for an App with none yet. */
  base: number | null;
  /** The SHA-256 of what it holds: two points alike hold the same. */
  contentHash: string;
  /** Who wrote it: the person, themselves or through their chat's agent. */
  personId: string;
  /** The chat whose agent wrote it; null for a person's own edit or restore. */
  chatId: string | null;
  /**
   * The code step or tool call (`ChatCode.callId`, `ChatToolCall.callId`)
   * that wrote it last, when a chat's agent did.
   */
  callId: string | null;
  /** The point the person restored as this one, if they did. */
  restoredFrom: number | null;
  /** When it was written (ISO 8601). */
  createdAt: string;
}

/** An undo point as the draft's history lists it (`AppDraftsApi.points`). */
export interface AppDraftHistoryPoint extends AppDraftPoint {
  /** The paths it changed against the point before it, sorted. */
  touched: string[];
  /**
   * How many paths it changes over its base: none for the draft as a
   * publish or roll back left it, the version it is over.
   */
  changes: number;
}

/**
 * One problem the draft's check found (`AppDraftChanges.check`): where it
 * is, a file and line or a route of the preview, and what it says, as
 * the build or the draft's own code wrote it.
 */
export interface AppDraftProblem {
  /** The App file, or the preview's route or server method; null for the App as a whole. */
  at: string | null;
  /** 1-based, in `at`'s file; null when it is about the whole file or not a file. */
  line: number | null;
  message: string;
}

/**
 * What publishing the draft would change against the live version
 * (`AppDraftsApi.changes`), worked out by core from the draft as it is
 * now, never taken from whoever wrote it, so code can't describe itself
 * as less than it is: its files, its server code, its data model, the
 * access the App holds and asks for, and whether its checks pass.
 */
export interface AppDraftChanges {
  /** The draft's revision this was read at: what a publish of it names. */
  revision: number;
  /** The live version it is compared with; null while none is. */
  live: number | null;
  /** The live version's label (`AppVersion.label`); null while none is. */
  liveLabel: string | null;
  /** The label the version it publishes would take now (`YY.MM.N`). */
  next: string;
  /** How its files differ from the live version's, by path. */
  files: FileDiff[];
  /**
   * How its server code (`grasp.config.ts`, `values.ts`, `server/`, as
   * its seal builds them) differs, if it does: it runs as whoever uses
   * the App, with every permission the App holds. Its files that differ
   * are `serverFiles`.
   */
  server: ReviewChange | null;
  serverFiles: { path: string; change: ReviewChange }[];
  /**
   * Its explicit migrations (spec 17.2) that the live version doesn't
   * have, or has otherwise (declared differently, or with server code
   * changed, which its transform may run), read from the App's manifest
   * wherever they are declared: each reads and rewrites every record of
   * its table, whoever owns it, once the version runs on the App's
   * store. Null when its manifest can't be read (its code doesn't build
   * or inspect): it may then rewrite any table. Each says how many
   * fixtures publishing runs it on: one that fails refuses the publish.
   */
  migrations:
    | {
        name: string;
        table: string;
        change: "added" | "modified";
        fixtures: number;
      }[]
    | null;
  /**
   * Whether its server code may hand files people can read to the
   * workflows it binds: it declares a files resource with `read` and a
   * bound workflow whose input can hold a file. Its pages' and server
   * code's starts then copy the person's file into the run, as they may
   * read it. Null when its manifest can't be read.
   */
  handsFilesToWorkflows: boolean | null;
  /**
   * Whether its server code and pages read the organization's people
   * (`permissions: { people: true }`): every member's name, email and
   * teams, for whoever uses it. No admin approves it; whoever publishes
   * sees it. Null when its manifest can't be read.
   */
  readsPeople: boolean | null;
  /**
   * Who sees and changes which rows of its tables, for each table that
   * declares row rules (`defineTable(...).access`). `read`: its read
   * rules, or null for reading left to the table's access mode. `write`:
   * who changes its rows, as the store holds a write: its write rules;
   * without them its read rules (for a write mode that reaches every
   * row) or the owner (for an `owner` mode), each of the rows they can
   * read too; null when nobody writes them (a `none` mode). A row reaches
   * whoever any of a direction's rules admits. Null when its manifest
   * can't be read.
   */
  rowRules: TableRowRules[] | null;
  /**
   * What the App asks for that no admin has granted yet: each waits for
   * an admin, whether the draft is published or not.
   */
  permissions: Permission[];
  /**
   * What the App holds now, which the draft's code uses once live;
   * `askedAgain` for each that publishing it would ask an admin for
   * again, as this person can't grant it (`AppDraftsApi.publish`).
   */
  grants: { permission: Permission; askedAgain: boolean }[];
  /**
   * The workflows' grants to call the App's functions, which trust its
   * code as its own grants do; `askedAgain` likewise. Only those this
   * person may see.
   */
  callers: { permission: Permission; askedAgain: boolean }[];
  /**
   * What publishing does to the App's records, from its definition; null
   * when the definition can't be read.
   */
  plan: DefinitionPlan | null;
  /**
   * The draft's check, as publishing checks it: whether it passes, and
   * the errors it found (warnings never fail it), at most 50.
   */
  check: { passed: boolean; problems: AppDraftProblem[] };
}

/**
 * An App's draft, for its builders (`apps.drafts`): read it, step back to
 * an undo point, discard it, publish it, change its definition, and
 * preview it. The draft runs in one preview per App, shared by its
 * builders, on a store of test data, never on the App's data; each
 * viewer acts in it as themselves.
 */
export interface AppDraftsApi {
  /** The App's draft now. */
  get: (app: string) => Promise<AppDraft>;
  /**
   * Every file of the App's draft as it is now: its changes over the
   * version it is over, or the App's latest version while it changes
   * nothing. For the App's code view, read-only.
   */
  files: (app: string) => Promise<AppFiles>;
  /**
   * The draft's undo points, newest first, with what each touched: the
   * newest page, or the page before point `before`.
   */
  points: (app: string, before?: number) => Promise<AppDraftHistoryPoint[]>;
  /**
   * What publishing the draft would change against the live version, and
   * whether its checks pass (`AppDraftChanges`), to review before
   * publishing it at the revision this names.
   */
  changes: (app: string) => Promise<AppDraftChanges>;
  /**
   * Makes undo point `point` the draft again, as a new point; refused
   * with `app.conflict` when the draft moved since `revision`, which the
   * person read.
   */
  restorePoint: (
    app: string,
    point: number,
    revision: number
  ) => Promise<AppDraftPoint>;
  /**
   * Discards the draft's changes; its undo points stay, to restore one.
   * Refused with `app.conflict` when the draft moved since `revision`.
   */
  discard: (app: string, revision: number) => Promise<void>;
  /**
   * Follows the draft: `onRevision` hears its revision after each write,
   * whoever made it, until the hold is released or the person no longer
   * builds the App.
   */
  watch: (
    app: string,
    onRevision: (revision: number) => void
  ) => Promise<SubscriptionApi>;
  /**
   * Clears the test data of the draft's preview, for everyone who builds
   * the App: its next call starts on an empty store. Not for an archived
   * App.
   */
  resetTestData: (app: string) => Promise<void>;
  /**
   * The tables of the preview's test data, on the data model of what it
   * shows, as the App's Data view lists the live ones (`AppDataTable`):
   * as the person reads them, their counts included. None for a draft
   * without tables; `app.not_running` for an App with nothing to show.
   */
  testTables: (app: string) => Promise<AppDataTable[]>;
  /**
   * A page of the test records of `table`, newest first, from `cursor`
   * (the last page's), as the person reads them.
   */
  testRecords: (
    app: string,
    table: string,
    cursor: string | null
  ) => Promise<AppDataPage>;
  /**
   * Publishes the draft at `revision`, the one the person read: checked
   * as a chat's agent's turn checks it, committed as the App's next
   * version, sealed, verified and made live, in one step, as the person.
   * The draft is then empty over the new version. Refused with
   * `app.conflict` when the draft moved since `revision` or another
   * version went live meanwhile, `app.draft_empty` when it changes
   * nothing, `app.draft_failed` when its check fails, and with the
   * refusal of a seal or verification that fails; a publish that fails
   * leaves no version. Published by anyone but one of the organization's
   * admins, the App's permissions that change things are asked for again:
   * they allow nothing until an admin grants them again
   * (`PermissionsApi.grant`). Resolves with the App, live. Not for an
   * archived App.
   */
  publish: (app: string, revision: number, message?: string) => Promise<App>;
  /**
   * The data model of the draft, from its definition, and what publishing
   * the draft does to the App's records.
   */
  dataModel: (app: string) => Promise<DraftDataModel>;
  /**
   * Changes the draft's definition by `operation` (an operation of
   * `@grasp-os/sdk/definition`, or a few made as one): the model after
   * it, the plan, and what this change alone does (`change`), or the
   * problem, which changed nothing. With `preview`, nothing is saved:
   * what it would do, to show first. Not for an archived App.
   */
  define: (
    app: string,
    operation: unknown,
    preview?: boolean
  ) => Promise<DataModelChange>;
  /**
   * The draft's pages, built, to preview: its frame's calls and live
   * queries carry the bundle's lease on the path every page calls on
   * (`PreviewBundle.lease`). A draft that changes nothing
   * previews the App's latest version, at the draft's revision, so its
   * next write comes into the frame; one whose changes leave no page that
   * builds opens on that version too (`PreviewBundle.fallback`). With
   * `point`, of that undo point, read-only: at `readOnlyRevision`, so its
   * calls are all refused; with `version` (and no point), of that
   * published version, read-only the same way.
   */
  preview: (
    app: string,
    point?: number,
    version?: number
  ) => Promise<PreviewBundle>;
  /**
   * What an open frame of the draft's preview, showing `shown`, takes at
   * `revision`, the newest the preview knows of (`PreviewUpdate`): one
   * build per revision, `app.preview_outdated` once the draft moved past
   * `revision`.
   */
  previewUpdate: (
    app: string,
    revision: number,
    shown: PreviewShown
  ) => Promise<PreviewUpdate>;
  /**
   * Keeps `problem`, one the preview of the draft at `at` ran into at the
   * route `path`, for the next check of the draft by any builder's
   * agent. A report of a revision the draft moved past, or of a
   * version of the App, is dropped.
   */
  previewReport: (
    app: string,
    at: PreviewAt,
    path: string,
    problem: PageProblem
  ) => Promise<void>;
}
