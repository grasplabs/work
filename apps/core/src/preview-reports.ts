import type { PreviewProblem } from "@grasp-os/shared/chat";
import { isDraftFault } from "@grasp-os/shared/functions";
import type { FunctionResult } from "@grasp-os/shared/functions";
import type { ServerLog } from "@grasp-os/shared/pages";

// What an App's preview of its draft ran into (app-preview.ts), for the
// next check of the draft by any builder's agent (agent-builds.ts): a
// plain list, read as it is when the check runs, and failing it while it
// has anything. The App's preview, open by any of its builders, adds what
// its page reported (uncaught errors,
// unhandled rejections, `console.error` calls); core adds what the draft's
// server code failed with on the page's calls. The agent's own calls
// (`env.build.call`) answer it directly and add nothing here. Next to the
// problems, what the draft's server code wrote with `console`, on anyone's
// calls (server-logs.ts): for the agent to read, failing nothing.
//
// Only the draft's current revision's problems are kept, in memory: a
// write starts the list afresh, and a restart loses it. With them, whether
// the preview reported on that revision at all (a problem, or a server
// call of its page; never the agent's calls or logs): a check right
// after a write waits a moment for the preview to catch up
// (agent-builds.ts), and says when it didn't. It waits only while
// someone has the preview open (loaded, called or reported on lately):
// any builder's open preview takes the draft's writes at once
// (app-preview.ts); the agent's own calls don't count.
//
// A problem is text the draft's code wrote, or what the person typed into
// the preview. It reaches the agent only as data in a check's result,
// never as instructions (agent-builds.ts). A preview reads no real data
// (draft-runs.ts: a store of test data, no resources), so it carries
// none.

/** Most problems kept of one revision, warnings aside: the first ones. */
const maxProblems = 10;

/**
 * Most warnings kept of one revision (React's development warnings, say):
 * the first ones, in slots of their own, so warnings never take the place
 * of a problem that fails a check.
 */
const maxWarnings = 10;

/** Most lines of server `console` output kept of one revision: the newest. */
const maxLogs = 50;

/**
 * How long a preview counts as open after it was last loaded, called or
 * reported on: a check waits for it only while open.
 */
const openForMs = 10 * 60 * 1000;

/** Most characters of a server failure's message kept. */
const maxMessage = 2000;

/** The function a call's request names, as text for a problem's `at`. */
const functionOf = (request: unknown): string => {
  try {
    const parsed: unknown =
      typeof request === "string" ? JSON.parse(request) : undefined;
    const reference: unknown =
      typeof parsed === "object" && parsed !== null
        ? Reflect.get(parsed, "reference")
        : undefined;
    const name: unknown =
      typeof reference === "object" && reference !== null
        ? Reflect.get(reference, "name")
        : undefined;
    return typeof name === "string" ? name.slice(0, 256) : "function";
  } catch {
    return "function";
  }
};

/** The refusals of a draft that a change of its code fixes (draft-runs.ts). */
export { draftSealFailures } from "@grasp-os/shared/functions";

/**
 * What a preview's call of a function of a draft of spec 8's layout
 * (draft-runs.ts) failed with, as a problem of the draft: one of its
 * code (`source`) or of a contract a function or its caller broke
 * (`contract`), or code that doesn't seal, all the draft's to fix;
 * nothing for a result that
 * succeeded, an error the App meant (`domain`), or a refusal that isn't
 * the draft's (an out-of-date preview, a person who lost access).
 */
export const functionProblem = (
  request: unknown,
  result: FunctionResult,
  /** What the draft's code threw, when the call hid it (`draftFailure`). */
  thrown?: string
): PreviewProblem | undefined => {
  if (result.ok) {
    return undefined;
  }
  // The draft's own code threw: what it said, as data, for its check.
  if (result.error.code === "internal.unexpected" && thrown !== undefined) {
    return {
      source: "server",
      at: functionOf(request),
      kind: "failed",
      message: thrown.slice(0, maxMessage),
    };
  }
  if (!isDraftFault(result.error.code)) {
    return undefined;
  }
  return {
    source: "server",
    at: functionOf(request),
    kind: "failed",
    message: `${result.error.code}: ${result.error.message}`.slice(
      0,
      maxMessage
    ),
  };
};

/**
 * What a preview of one revision ran into, what its server logged, and
 * whether the preview reported on it at all (`seen`).
 */
export interface Reports {
  problems: PreviewProblem[];
  logs: ServerLog[];
  seen: boolean;
}

/** The reports of one App's preview (app-preview.ts). */
export class PreviewReports {
  #reports: (Reports & { revision: number }) | undefined;

  /** When a viewer was last on the preview (`opened`). */
  #open: number | undefined;

  /**
   * The reports of the preview of the draft at `revision`, to add to:
   * undefined for an earlier revision than the one kept, whose reports
   * are dropped; a later one starts afresh.
   */
  #at(revision: number): Reports | undefined {
    const kept = this.#reports;
    if (kept !== undefined && kept.revision > revision) {
      return undefined;
    }
    if (kept?.revision === revision) {
      return kept;
    }
    const fresh = { revision, problems: [], logs: [], seen: false };
    this.#reports = fresh;
    return fresh;
  }

  /** Notes that a viewer's page reported on the draft at `revision`. */
  saw(revision: number): void {
    this.opened();
    const reports = this.#at(revision);
    if (reports !== undefined) {
      reports.seen = true;
    }
  }

  /**
   * Keeps `problem`, one the preview of the draft at `revision` ran
   * into, while there's room: the first ones, warnings in their own
   * slots (`maxWarnings`), so no number of them pushes out a problem.
   */
  report(revision: number, problem: PreviewProblem): void {
    this.opened();
    const reports = this.#at(revision);
    if (reports === undefined) {
      return;
    }
    reports.seen = true;
    const warning = problem.kind === "warning";
    const kept = reports.problems.filter(
      ({ kind }) => (kind === "warning") === warning
    ).length;
    if (kept < (warning ? maxWarnings : maxProblems)) {
      reports.problems.push(problem);
    }
  }

  /**
   * Keeps `logs`, what the draft's server code at `revision` wrote with
   * `console` in its preview (server-logs.ts): the newest ones.
   */
  log(revision: number, logs: ServerLog[]): void {
    const reports = this.#at(revision);
    if (reports !== undefined) {
      reports.logs = [...reports.logs, ...logs].slice(-maxLogs);
    }
  }

  /** What the preview of the draft at `revision` reported. */
  read(revision: number): Reports {
    const reports = this.#reports;
    return reports?.revision === revision
      ? { problems: reports.problems, logs: reports.logs, seen: reports.seen }
      : { problems: [], logs: [], seen: false };
  }

  /** Notes that a viewer has the preview open: it loaded, called or reported. */
  opened(): void {
    this.#open = Date.now();
  }

  /** Whether a viewer was on the preview lately. */
  isOpen(): boolean {
    return this.#open !== undefined && Date.now() - this.#open < openForMs;
  }

  /** Forgets what the preview ran into, and that it was open. */
  drop(): void {
    this.#reports = undefined;
    this.#open = undefined;
  }
}
