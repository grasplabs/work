import type { AppDataPage, AppDataTable } from "./app-data.ts";
import type { FileDiff, ReviewChange, TableRowRules } from "./apps.ts";
import type {
  PreviewAt,
  PreviewBundle,
  PreviewShown,
  PreviewUpdate,
} from "./chat.ts";
import type { DefinitionPlan } from "./data-model.ts";
import type { PageProblem } from "./pages.ts";
import type { Permission } from "./permissions.ts";

// What is App-only about an App's draft (core's app-preview-rpc.ts and
// apps-rpc.ts): its review before publishing, and its preview. The draft
// itself, its checkpoints and its publish are every subject's
// (@grasp-os/shared/drafts).

/**
 * One problem the draft's check found (`AppReview.check`): where it
 * is, a file and line or a route of the preview, and what it says, as
 * the build or the draft's own code wrote it.
 */
export interface DraftProblem {
  /** The App file, or the preview's route or server method; null for the App as a whole. */
  at: string | null;
  /** 1-based, in `at`'s file; null when it is about the whole file or not a file. */
  line: number | null;
  message: string;
}

/**
 * What publishing the draft would change against the live version
 * (`AppsApi.review`), worked out by core from the draft as it is
 * now, never taken from whoever wrote it, so code can't describe itself
 * as less than it is: its files, its server code, its data model, the
 * access the App holds and asks for, and whether its checks pass.
 */
export interface AppReview {
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
   * again, as this person can't grant it (`DraftsApi.publish`).
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
  check: { passed: boolean; problems: DraftProblem[] };
}

/**
 * The preview of an App's draft, for its builders (`apps.preview`): one
 * per App, shared by its builders, on a store of test data, never on the
 * App's data; each viewer acts in it as themselves.
 */
export interface AppPreviewApi {
  /**
   * The draft's pages, built, to preview: its frame's calls and live
   * queries carry the bundle's lease on the path every page calls on
   * (`PreviewBundle.lease`). A draft that changes nothing previews the
   * App's latest version, at the draft's revision, so its next write
   * comes into the frame; one whose changes leave no page that builds
   * opens on that version too (`PreviewBundle.fallback`). With
   * `checkpoint`, of that checkpoint of the draft, read-only: at
   * `readOnlyRevision`, so its calls are all refused; with `version` (and
   * no checkpoint), of that published version, read-only the same way.
   */
  open: (
    app: string,
    checkpoint?: number,
    version?: number
  ) => Promise<PreviewBundle>;
  /**
   * What an open frame of the draft's preview, showing `shown`, takes at
   * `revision`, the newest the preview knows of (`PreviewUpdate`): one
   * build per revision, `app.preview_outdated` once the draft moved past
   * `revision`.
   */
  update: (
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
  report: (
    app: string,
    at: PreviewAt,
    path: string,
    problem: PageProblem
  ) => Promise<void>;
  /**
   * Clears the preview's test data, for everyone who builds the App: its
   * next call starts on an empty store. Not for an archived App.
   */
  resetData: (app: string) => Promise<void>;
  /**
   * The tables of the preview's test data, on the data model of what it
   * shows, as the App's Data view lists the live ones (`AppDataTable`):
   * as the person reads them, their counts included. None for a draft
   * without tables; `app.not_running` for an App with nothing to show.
   */
  tables: (app: string) => Promise<AppDataTable[]>;
  /**
   * A page of the test records of `table`, newest first, from `cursor`
   * (the last page's), as the person reads them.
   */
  records: (
    app: string,
    table: string,
    cursor: string | null
  ) => Promise<AppDataPage>;
}
