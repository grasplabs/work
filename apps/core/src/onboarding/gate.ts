import type { AuditActor } from "@grasp-os/shared/audit";
import { staffWindowOpen } from "@grasp-os/shared/deployment-config";
import type { SignInConfig } from "@grasp-os/shared/deployment-config";
import type { OnboardingView } from "@grasp-os/shared/onboarding";
import {
  gateThresholdDefault,
  gateThresholds,
  knownWeights,
} from "@grasp-os/shared/onboarding-gate";
import type {
  GateThreshold,
  GateView,
  KnownPart,
} from "@grasp-os/shared/onboarding-gate";
import { and, eq, inArray, isNotNull, isNull, not, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxed, outboxedIfChanged } from "../audit-outbox.ts";
import { signInConfig } from "../auth/config.ts";
import { onboardingGate, sessions, users } from "../db/core/schema.ts";
import { closesOn, dayOf } from "./rules.ts";

// The gate of a deployment that is onboarding (`@grasp-os/shared/onboarding-gate`).
// From the threat model (GRA-307, W10), what it can't let happen, and what
// stops it:
//
// - Someone in the company reaching the platform before Grasp's go: while
//   the gate is closed, a sign-in through the company's IdP is refused
//   (`not_open_yet`) unless its email is one of the admins named in
//   `SIGN_IN`; no user, no membership and no session is made for them.
//   Grasp's staff sign in as ever.
// - A session from before the gate closed: closing it ends every session
//   but staff's and those admins', in the same batch.
// - Opening or closing it without a trace, or by anyone else: only staff
//   move it, and each move is in the audit log as the staff member.
//
// A deployment that never closed it is open: closing it is the first thing
// staff do for a client that onboards.

const gateRow = "gate";

/** The gate as stored: closed since when, and the threshold. */
const stored = async (
  env: Pick<Env, "DB">
): Promise<{ closedAt: Date | null; threshold: GateThreshold }> => {
  const [row] = await drizzle(env.DB)
    .select()
    .from(onboardingGate)
    .where(eq(onboardingGate.id, gateRow));
  const threshold = gateThresholds.find((each) => each === row?.threshold);
  return {
    closedAt: row?.closedAt ?? null,
    threshold: threshold ?? gateThresholdDefault,
  };
};

/** Whether `email` may sign in through the company's IdP now. */
export const mayComeIn = async (
  env: Pick<Env, "DB">,
  config: SignInConfig,
  email: string | undefined
): Promise<boolean> => {
  if (email !== undefined && config.admins.includes(email.toLowerCase())) {
    return true;
  }
  const { closedAt } = await stored(env);
  return closedAt === null;
};

const part = (source: KnownPart["source"], known: number): KnownPart => ({
  source,
  weight: knownWeights[source],
  known: Math.min(Math.max(known, 0), 1),
});

const share = (some: number, of: number): number => (of === 0 ? 0 : some / of);

/**
 * What Grasp knows of the company, part by part, from what the onboarding
 * holds. The kickoff, the documents, where they live, Pulse and the review
 * come in with their own issues (GRA-318, GRA-299, GRA-300, GRA-304) and
 * count nothing until then.
 */
export const knownParts = (view: OnboardingView): KnownPart[] => {
  const { roster, progress } = view;
  const taking = roster?.teams.filter((team) => !team.off) ?? [];
  const conversations =
    progress === null
      ? 0
      : 0.5 * share(progress.leadsTalked, progress.leads) +
        0.5 * share(progress.talked, progress.asked);
  return [
    part("kickoff", 0),
    part("people", roster === null ? 0 : 1),
    part("sources", 0),
    part("documents", 0),
    part("tools", 0),
    part(
      "leads",
      taking.length > 0 && taking.every((team) => team.lead !== null) ? 1 : 0
    ),
    part("conversations", conversations),
    part("review", 0),
  ];
};

/** How long staff with the onboarding scope keep access after Grasp's go. */
export const staffAfterGoMs = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether Grasp's staff may be in now, by what the company decided: not
 * when its admin ended staff access after the console opened this window
 * (`windowOpened`), and, for the onboarding scope, not past 7 days after
 * Grasp's go.
 */
export const staffMayStay = async (
  env: Pick<Env, "DB">,
  windowOpened: string,
  scope: "full" | "onboarding",
  now = Date.now()
): Promise<boolean> => {
  const [row] = await drizzle(env.DB)
    .select({
      openedAt: onboardingGate.openedAt,
      closedAt: onboardingGate.closedAt,
      staffEndedAt: onboardingGate.staffEndedAt,
    })
    .from(onboardingGate)
    .where(eq(onboardingGate.id, gateRow));
  const ended = row?.staffEndedAt?.getTime();
  if (ended !== undefined && ended >= Date.parse(windowOpened)) {
    return false;
  }
  const opened = row?.closedAt === null ? row.openedAt?.getTime() : undefined;
  return !(
    scope === "onboarding" &&
    opened !== undefined &&
    now > opened + staffAfterGoMs
  );
};

/** The gate, with how much Grasp knows by `view` of the onboarding. */
export const gateView = async (
  env: Env,
  view: OnboardingView,
  now: string = new Date().toISOString()
): Promise<GateView> => {
  const { closedAt, threshold } = await stored(env);
  const parts = knownParts(view);
  let sum = 0;
  for (const { weight, known } of parts) {
    sum += weight * known;
  }
  const known = Math.round(sum);
  const over = view.plan !== null && dayOf(now) > closesOn(view.plan);
  const config = signInConfig(env);
  const staff = config?.staff;
  return {
    open: closedAt === null,
    closedSince: closedAt?.toISOString() ?? null,
    threshold,
    known,
    parts,
    ready: known >= threshold || over,
    staff:
      staff === undefined || config === undefined
        ? null
        : {
            open:
              staffWindowOpen(config, Date.parse(now)) &&
              (await staffMayStay(
                env,
                staff.opened,
                staff.scope,
                Date.parse(now)
              )),
            scope: staff.scope,
            until: staff.until,
          },
  };
};

/**
 * Closes the gate, and ends every session but staff's and the configured
 * admins': one batch, with its audit event, so either all of it happened
 * and is on record, or none.
 */
export const closeGate = async (
  env: Env,
  config: SignInConfig,
  by: AuditActor
): Promise<void> => {
  const db = drizzle(env.DB);
  const now = new Date();
  const { threshold } = await stored(env);
  const admins = db
    .select({ id: users.id })
    .from(users)
    .where(
      config.admins.length === 0
        ? sql`0`
        : inArray(sql`lower(${users.email})`, config.admins)
    );
  await auditedBatch(env, db, [
    db
      .insert(onboardingGate)
      .values({ id: gateRow, closedAt: now, threshold })
      .onConflictDoUpdate({
        target: onboardingGate.id,
        set: { closedAt: now },
        setWhere: isNull(onboardingGate.closedAt),
      }),
    outboxedIfChanged(db, {
      actor: by,
      action: "onboarding.gate.closed",
      target: { type: "deployment", id: gateRow },
      detail: {},
    }),
    db
      .delete(sessions)
      .where(
        and(eq(sessions.staff, false), not(inArray(sessions.userId, admins)))
      ),
  ]);
};

/**
 * Ends Grasp's staff access, as the company's admin: every staff session
 * goes now, and the window the console opened lets nobody in again; only
 * a window the console opens afterwards does. In one batch, audited as
 * the admin.
 */
export const endStaffAccess = async (
  env: Env,
  by: AuditActor
): Promise<void> => {
  const db = drizzle(env.DB);
  const now = new Date();
  const { threshold } = await stored(env);
  await auditedBatch(env, db, [
    db
      .insert(onboardingGate)
      .values({ id: gateRow, closedAt: null, threshold, staffEndedAt: now })
      .onConflictDoUpdate({
        target: onboardingGate.id,
        set: { staffEndedAt: now },
      }),
    db.delete(sessions).where(eq(sessions.staff, true)),
    outboxed(db, {
      actor: by,
      action: "onboarding.staff_access.ended",
      target: { type: "deployment", id: gateRow },
      detail: {},
    }),
  ]);
};

/** Grasp's go: opens the gate to everyone in the company. */
export const openGate = async (env: Env, by: AuditActor): Promise<void> => {
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(onboardingGate)
      .set({ closedAt: null, openedAt: new Date() })
      .where(
        and(eq(onboardingGate.id, gateRow), isNotNull(onboardingGate.closedAt))
      ),
    outboxedIfChanged(db, {
      actor: by,
      action: "onboarding.gate.opened",
      target: { type: "deployment", id: gateRow },
      detail: {},
    }),
  ]);
};

/** Sets how much Grasp has to know before the gate is ready to open. */
export const setGateThreshold = async (
  env: Env,
  threshold: GateThreshold,
  by: AuditActor
): Promise<void> => {
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .insert(onboardingGate)
      .values({ id: gateRow, closedAt: null, threshold })
      .onConflictDoUpdate({
        target: onboardingGate.id,
        set: { threshold },
        setWhere: sql`${onboardingGate.threshold} <> ${threshold}`,
      }),
    outboxedIfChanged(db, {
      actor: by,
      action: "onboarding.gate.threshold_set",
      target: { type: "deployment", id: gateRow },
      detail: { threshold },
    }),
  ]);
};
