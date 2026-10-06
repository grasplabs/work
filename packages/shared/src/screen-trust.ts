import { z } from "zod";

import { appVersionSchema } from "./apps.ts";
import type { AppId } from "./ids.ts";

// Whether an App's screens get its data. A screen is code nobody reviewed
// line by line, running in the person's browser, where no sandbox closes
// every way out (a frame can still reach a TURN server, say). So core
// hands an App's data to a screen only once a person has approved that
// exact code, or once an admin has said the App's data may go to code
// nobody approved. Both are core's own records; nothing a screen or the
// page says counts.

/** A screen's code as core built it: the SHA-256, in hex, of what a frame is handed. */
export const artifactSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * What an admin decided about one exact build of a screen, the only
 * thing core records about it: `approved` this code, or `revoked` that
 * approval. A revoked build gets nothing, however its App's data is
 * classified.
 */
export const artifactDecisions = ["approved", "revoked"] as const;
export type ArtifactDecision = (typeof artifactDecisions)[number];

/** What core holds about a build: a decision, or none yet (`unreviewed`). */
export type ArtifactTrust = ArtifactDecision | "unreviewed";

/**
 * What an App's data is to its screens:
 * - `sensitive`, as every App's is until an admin says otherwise: only
 *   approved code gets it;
 * - `ordinary`: an admin accepted that it goes to code nobody approved.
 */
export const outputClassSchema = z.enum(["sensitive", "ordinary"]);
export type OutputClass = z.output<typeof outputClassSchema>;

/**
 * Whether a screen gets its App's data now: `open`, or why not. Core
 * decides it again on every call and every push.
 */
export type ScreenDelivery = "open" | "unreviewed" | "revoked";

/** One screen of a version, as core builds it now, and what it holds about that build. */
export interface ReviewedScreen {
  screen: string;
  /**
   * The hash it builds to now; null when it doesn't build now (it fails,
   * or didn't finish within the build wait), so there is nothing of it to
   * approve yet.
   */
  artifact: string | null;
  trust: ArtifactTrust;
  /** Who approved or revoked it, and when (ISO 8601); null while nobody has. */
  decidedBy: string | null;
  decidedAt: string | null;
}

/**
 * The hashes of the screens of a review that build now: what approving
 * that version names, once every one of them builds.
 */
export const builtArtifacts = (screens: readonly ReviewedScreen[]): string[] =>
  screens.flatMap(({ artifact }) => (artifact === null ? [] : [artifact]));

/** A build of one of an App's screens that an admin decided on, at any version. */
export interface DecidedBuild {
  artifact: string;
  /** The version and screen it was decided for. */
  version: number;
  screen: string;
  trust: ArtifactDecision;
  /** Who made the decision, and when (ISO 8601). */
  decidedBy: string;
  decidedAt: string;
}

/**
 * The screens of one version of an App, as an admin reviews them: what
 * each builds to now, with this release's kit, and what core holds about
 * exactly that; and every build of the App's screens an admin decided on,
 * older versions' too, newest decision first (`decided`), so any approval
 * can be taken back. `generation` counts the App's approvals, revocations
 * and changes of `output`: an approval names the one it was reviewed
 * under.
 */
export interface ScreenTrustReview {
  app: AppId;
  name: string;
  version: number;
  output: OutputClass;
  generation: number;
  screens: ReviewedScreen[];
  decided: DecidedBuild[];
}

/**
 * An App whose data is sensitive and whose current version has screens
 * that build to code no admin decided on.
 */
export interface ScreensWaiting {
  app: AppId;
  name: string;
  version: number;
  /** Those screens' names. */
  screens: string[];
}

/** A policy generation, as an admin was shown it. */
export const generationSchema = z.int().nonnegative();

/** What an admin approves: exactly what they reviewed, as core told it. */
export const screenApprovalSchema = z.strictObject({
  version: appVersionSchema,
  generation: generationSchema,
  artifacts: z.array(artifactSchema).min(1).max(256),
});
export type ScreenApproval = z.input<typeof screenApprovalSchema>;

/**
 * A signed-in person's way to what core holds about Apps' screens. Only
 * the organization's own admins approve, revoke and classify, from their
 * own session: never Grasp staff, an agent, a workflow or an App.
 */
export interface ScreenTrustApi {
  /**
   * The screens of the App's `version` (its current one when left out),
   * built now. For the App's builders, which every admin is.
   */
  review: (app: string, version?: number) => Promise<ScreenTrustReview>;
  /**
   * Approves exactly the screens reviewed: refused with
   * `screen.review_outdated` when the version builds to anything else by
   * now (a new kit, say), or the App's approvals changed meanwhile.
   */
  approve: (
    app: string,
    reviewed: ScreenApproval
  ) => Promise<ScreenTrustReview>;
  /**
   * Takes back the approval of one build: its screens get nothing more
   * from the next call or push on. What a browser already has stays there
   * until its page hears of it.
   */
  revoke: (app: string, artifact: string) => Promise<void>;
  /**
   * Says what the App's data is to its screens, under the policy
   * generation the admin reviewed (`ScreenTrustReview.generation`):
   * refused with `screen.review_outdated` once it moved on, by an
   * approval, a revocation or a grant. `ordinary` holds only for
   * the permissions the App had when it was said: a permission granted to
   * the App afterwards makes its data `sensitive` again, in the grant's
   * batch, for an admin to decide again.
   */
  classify: (
    app: string,
    output: OutputClass,
    generation: number
  ) => Promise<OutputClass>;
  /**
   * The source the App's screens at `version` are built from, by path:
   * what an approval of that version's builds stands for, besides the
   * release's kit. For the App's builders, which every admin is.
   */
  source: (app: string, version: number) => Promise<Record<string, string>>;
  /** The Apps with screens waiting for approval; none for anyone but an admin. */
  waiting: () => Promise<ScreensWaiting[]>;
}
