import type { OnboardingProgress, Programme } from "./onboarding.ts";
import type { SignalKind } from "./signals.ts";
import type { RunActivity } from "./workflows.ts";

// The weekly report on the board, while the company has a programme with
// Grasp: core reads it in one call (core's board-report.ts), each part as
// the person may read it; the inbox shows its bar and exports it.

/**
 * One part of the board report, as core read it for the person: what it
 * says, or why it couldn't be read. A part that fails leaves the rest.
 */
export type BoardReportPart<T> =
  | { state: "read"; data: T }
  | { state: "unread"; code: string };

/** How many improvement signals of one kind there are. */
export interface SignalCount {
  kind: SignalKind;
  count: number;
}

/**
 * The weekly report on the board, read in one call: everything core
 * knows of what it says, each part as the person may read it. What ran
 * and the decisions runs asked for are of the next report's window
 * (`Programme.reportWindow`; today alone without a programme); the rest
 * stands as it is now.
 */
export interface BoardReport {
  /** The programme and where today falls in it; null without a plan. */
  programme: BoardReportPart<Programme | null>;
  /** The runs started in the report's window, of the Apps the person can open. */
  runs: BoardReportPart<RunActivity>;
  /** How many of the person's workflows didn't run in the window. */
  idleWorkflows: BoardReportPart<number>;
  /**
   * How many signals of each kind there are: every one for admins, an
   * App's for its builders, their own collections' for owners. Null for
   * someone who reads none, so the report leaves the section out.
   */
  better: BoardReportPart<SignalCount[] | null>;
  /**
   * How many the interviews heard; null before anyone was asked. Only
   * for admins, Grasp staff included: absent for everyone else.
   */
  people?: BoardReportPart<OnboardingProgress | null>;
}

/** The signed-in person's weekly report. */
export interface BoardReportApi {
  /**
   * The weekly report as it stands now, each part as the person may read
   * it. Reading it changes nothing and isn't audited.
   */
  read: () => Promise<BoardReport>;
}
