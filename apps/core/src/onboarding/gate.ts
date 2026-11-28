import { dayOf } from "@grasp-os/shared/admin/org-record";
import type { AuditActor } from "@grasp-os/shared/audit";
import { staffWindowOpen } from "@grasp-os/shared/deployment-config";
import type { SignInConfig } from "@grasp-os/shared/deployment-config";
import type { OnboardingView } from "@grasp-os/shared/onboarding";
import { noChoices } from "@grasp-os/shared/onboarding-choices";
import type { SetupChoices } from "@grasp-os/shared/onboarding-choices";
import { flowOpening, flowScreens } from "@grasp-os/shared/onboarding-flow";
import {
  gateThresholdDefault,
  gateThresholds,
  knownPercent,
  knownSourcesOf,
  knownWeights,
} from "@grasp-os/shared/onboarding-gate";
import type {
  GateThreshold,
  GateView,
  KnownPart,
} from "@grasp-os/shared/onboarding-gate";
import { and, eq, inArray, isNotNull, isNull, not, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed, outboxedIfChanged } from "../audit-outbox.ts";
import { signInConfig } from "../auth/config.ts";
import { activeMember } from "../auth/membership-sql.ts";
import { onboardingGate, sessions, users } from "../db/core/schema.ts";
import { identityChanged } from "../identity-changes.ts";
import { closesOn } from "./rules.ts";
import { onboardingStore } from "./store.ts";

// The gate of a deployment that is onboarding (`@grasp-os/shared/onboarding-gate`).
// From the threat model (GRA-307, W10), what it can't let happen, and what
// stops it:
//
// - Someone in the company reaching the platform before Grasp's go: while
//   the gate is closed, a sign-in through the company's IdP is refused
//   (`not_open_yet`) unless its email is one of the admins named in
//   `SIGN_IN`, or one an interview link went to (GRA-1790); no user, no
//   membership and no session is made for anyone else. Grasp's staff sign
//   in as ever.
// - Someone signing in for their interview reaching anything else: their
//   session is marked as an interview's (`sessions.interview`), no
//   membership is made, every route but the interview's finds nobody
//   behind it (identity.ts `sessionIdentity`), and opening the gate ends
//   it, so they sign in again as a member.
// - A session from before the gate closed: closing it ends every session
//   but staff's and the admins', in the same batch.
// - Opening or closing it without a trace, or by anyone else: only staff
//   move it, and each move is in the audit log as the staff member.
//
// A deployment whose gate was never moved is open, unless it was made
// closed: one staff added with an onboarding starts closed
// (`ONBOARDING_CLOSED_FROM`), so nobody but its admins comes in before
// staff remember to close it. Any other is open until staff close it.

const gateRow = "gate";

/** The env the gate reads: its row, and how the deployment starts. */
type GateEnv = Pick<Env, "DB" | "ONBOARDING_CLOSED_FROM">;

/** When a deployment that starts closed was made; null for one that starts open. */
const startsClosedAt = (env: GateEnv): Date | null => {
  const from = z.iso.datetime().safeParse(env.ONBOARDING_CLOSED_FROM);
  return from.success ? new Date(from.data) : null;
};

/**
 * Whether this deployment starts closed, as the admin's probe asks
 * before it publishes a new company's address (provision-probe.ts).
 */
export const startsClosed = (
  env: Pick<Env, "ONBOARDING_CLOSED_FROM">
): boolean => z.iso.datetime().safeParse(env.ONBOARDING_CLOSED_FROM).success;

/**
 * The gate as stored: closed since when, and the threshold. A deployment
 * that starts closed has that kept the first time its gate is read, as
 * closed since it was made: from then on the gate is only what was done
 * to it, and the deployment's config no longer says anything of it.
 */
const stored = async (
  env: GateEnv
): Promise<{
  closedAt: Date | null;
  openedAt: Date | null;
  threshold: GateThreshold;
}> => {
  const db = drizzle(env.DB);
  const read = async () => {
    const [found] = await db
      .select()
      .from(onboardingGate)
      .where(eq(onboardingGate.id, gateRow));
    return found;
  };
  let row = await read();
  const start = row === undefined ? startsClosedAt(env) : null;
  if (start !== null) {
    await db
      .insert(onboardingGate)
      .values({ id: gateRow, closedAt: start, threshold: gateThresholdDefault })
      .onConflictDoNothing();
    row = await read();
  }
  const threshold = gateThresholds.find((each) => each === row?.threshold);
  return {
    closedAt: row?.closedAt ?? null,
    openedAt: row?.openedAt ?? null,
    threshold: threshold ?? gateThresholdDefault,
  };
};

/** Whether the gate is open: the company's people come in. */
export const gateOpen = async (env: Pick<Env, "DB">): Promise<boolean> => {
  const { closedAt } = await stored(env);
  return closedAt === null;
};

/**
 * The company's admins as its members stand now: whoever holds the admin
 * role and may act, whether the deployment's config names them or another
 * admin made them one. As SQL on `users`.
 */
const isAdminMember = activeMember(users.id, ["admin"]);

/**
 * Whether `email` may sign in through the company's IdP now: anyone while
 * the gate is open; while it is closed, the admins the deployment's config
 * names, and every member who is an admin, so the onboarding is all of
 * its admins' to do, not the first one's alone.
 */
export const mayComeIn = async (
  env: GateEnv,
  config: SignInConfig,
  email?: string
): Promise<boolean> => {
  const address = email?.toLowerCase();
  if (address !== undefined && config.admins.includes(address)) {
    return true;
  }
  const { closedAt } = await stored(env);
  if (closedAt === null) {
    return true;
  }
  if (address === undefined) {
    return false;
  }
  const [admin] = await drizzle(env.DB)
    .select({ id: users.id })
    .from(users)
    .where(and(eq(sql`lower(${users.email})`, address), isAdminMember))
    .limit(1);
  return admin !== undefined;
};

/**
 * Whether the member `userId` may hold a session now, as they are once
 * they joined: anyone while the gate is open; while it is closed, an
 * admin the deployment's config names, or a member who is an admin now.
 * Asked after their membership is made, so whoever came in as the admin
 * they were about to be, and joined as less, is not let in after all.
 */
export const memberMayBeIn = async (
  env: Pick<Env, "DB">,
  config: SignInConfig,
  userId: string
): Promise<boolean> => {
  const [user] = await drizzle(env.DB)
    .select({
      email: users.email,
      admin: sql<number>`${isAdminMember}`,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (user === undefined) {
    return false;
  }
  if (config.admins.includes(user.email.toLowerCase())) {
    return true;
  }
  const { closedAt } = await stored(env);
  return closedAt === null || user.admin === 1;
};

const part = (source: KnownPart["source"], known: number): KnownPart => ({
  source,
  weight: knownWeights[source],
  known: Math.min(Math.max(known, 0), 1),
});

const share = (some: number, of: number): number => (of === 0 ? 0 : some / of);

/**
 * What Grasp knows of the company, part by part, from what the onboarding
 * holds; the kickoff by how much of what Stephen needs from it is in
 * (`kickoff`, 0 to 1), and the documents once any is shared (`documents`).
 * From what the admin chose (`choices`): where the documents live once a
 * place is noted or connected (one only asked for by name is not), the
 * tools once Pulse is to be set up, and the leads from an HR platform
 * named, as from every team taking part having one. The review by how
 * much of what needs the admin is settled and how much of the work is
 * known (`review`, 0 to 1).
 */
export const knownParts = (
  view: OnboardingView,
  kickoff = 0,
  documents = 0,
  choices: SetupChoices = noChoices,
  review = 0
): KnownPart[] => {
  const { roster, progress } = view;
  const taking = roster?.teams.filter((team) => !team.off) ?? [];
  const conversations =
    progress === null
      ? 0
      : 0.5 * share(progress.leadsTalked, progress.leads) +
        0.5 * share(progress.talked, progress.asked);
  return [
    part("kickoff", kickoff),
    part("people", roster === null ? 0 : 1),
    part("sources", choices.sources.length > 0 ? 1 : 0),
    part("documents", documents),
    part("tools", choices.pulse === "wanted" ? 1 : 0),
    part(
      "leads",
      choices.hr?.kind === "platform" ||
        (taking.length > 0 && taking.every((team) => team.lead !== null))
        ? 1
        : 0
    ),
    part("conversations", conversations),
    part("review", review),
  ];
};

/** How long staff with the onboarding scope keep access after Grasp's go. */
export const staffAfterGoMs = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether Grasp's staff may be in now, by what the company decided: not
 * when its admin ended staff access after Grasp's admin opened this window
 * (`windowOpened`), and, for the onboarding scope, not past 7 days after
 * Grasp's go. The go counts once given, whether or not the gate was closed
 * again since: closing it never gives staff back access the go ended.
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
      staffEndedAt: onboardingGate.staffEndedAt,
    })
    .from(onboardingGate)
    .where(eq(onboardingGate.id, gateRow));
  const ended = row?.staffEndedAt?.getTime();
  if (ended !== undefined && ended >= Date.parse(windowOpened)) {
    return false;
  }
  const opened = row?.openedAt?.getTime();
  return !(
    scope === "onboarding" &&
    opened !== undefined &&
    now > opened + staffAfterGoMs
  );
};

/**
 * Whether the company's admin ended Grasp's staff access and no window
 * the admin opened since has given it back, as `staffMayStay` counts a
 * window opened after the end.
 */
export const staffAccessEnded = async (
  env: Pick<Env, "DB">,
  windowOpened: string | undefined
): Promise<boolean> => {
  const [row] = await drizzle(env.DB)
    .select({ staffEndedAt: onboardingGate.staffEndedAt })
    .from(onboardingGate)
    .where(eq(onboardingGate.id, gateRow));
  const ended = row?.staffEndedAt?.getTime();
  if (ended === undefined) {
    return false;
  }
  return windowOpened === undefined || Date.parse(windowOpened) <= ended;
};

/**
 * When staff access ends: the admin's window, or, for the onboarding
 * scope, 7 days after Grasp's go when that comes first.
 */
const staffUntil = (
  staff: { until: string; scope: "full" | "onboarding" },
  openedAt: Date | null
): string => {
  if (staff.scope !== "onboarding" || openedAt === null) {
    return staff.until;
  }
  const afterGo = openedAt.getTime() + staffAfterGoMs;
  return afterGo < Date.parse(staff.until)
    ? new Date(afterGo).toISOString()
    : staff.until;
};

/**
 * When a staff session's access ends by itself, by the deployment's
 * config (`staffUntil`): the admin's window, or 7 days after Grasp's go
 * for the onboarding scope. Undefined without staff access.
 */
export const staffEndsAt = async (env: Env): Promise<number | undefined> => {
  const staff = signInConfig(env)?.staff;
  if (staff === undefined) {
    return undefined;
  }
  const { openedAt } = await stored(env);
  return Date.parse(staffUntil(staff, openedAt));
};

/** The gate, with how much Grasp knows by `view` of the onboarding. */
export const gateView = async (
  env: Env,
  view: OnboardingView,
  now: string = new Date().toISOString()
): Promise<GateView> => {
  const { closedAt, openedAt, threshold } = await stored(env);
  const store = onboardingStore(env);
  const shared = await store.documents();
  // Only what this company's flow asks it for counts: a step that is off
  // can't hold the percentage down.
  const { flow } = await store.flow();
  const asked = knownSourcesOf(flow);
  const every = knownParts(
    view,
    await store.kickoffKnown(),
    shared.length > 0 ? 1 : 0,
    await store.choices(),
    await store.reviewKnown()
  );
  const parts = every.filter(({ source }) => asked.includes(source));
  const known = knownPercent(parts);
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
    over,
    openedAt: openedAt?.toISOString() ?? null,
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
            until: staffUntil(staff, openedAt),
          },
  };
};

/**
 * Closes the gate, and ends every session but staff's and the admins'
 * (those the config names, and every member who is one): one batch, with
 * its audit event, so either all of it happened and is on record, or none.
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
        ? isAdminMember
        : or(inArray(sql`lower(${users.email})`, config.admins), isAdminMember)
    );
  const results = await auditedBatch(env, db, [
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
      )
      .returning({ userId: sessions.userId }),
  ]);
  identityChanged(
    env,
    results[2].map(({ userId }) => userId)
  );
};

/**
 * Ends Grasp's staff access, as the company's admin: every staff session
 * goes now, and the window the admin opened lets nobody in again; only
 * a window the admin opens afterwards does. In one batch, audited as
 * the admin.
 */
export const endStaffAccess = async (
  env: Env,
  by: AuditActor
): Promise<void> => {
  const db = drizzle(env.DB);
  const now = new Date();
  const { threshold } = await stored(env);
  const [, ended] = await auditedBatch(env, db, [
    db
      .insert(onboardingGate)
      .values({ id: gateRow, closedAt: null, threshold, staffEndedAt: now })
      .onConflictDoUpdate({
        target: onboardingGate.id,
        set: { staffEndedAt: now },
      }),
    db
      .delete(sessions)
      .where(eq(sessions.staff, true))
      .returning({ userId: sessions.userId }),
    outboxed(db, {
      actor: by,
      action: "onboarding.staff_access.ended",
      target: { type: "deployment", id: gateRow },
      detail: {},
    }),
  ]);
  identityChanged(
    env,
    ended.map(({ userId }) => userId)
  );
};

/**
 * Why the gate opened: Grasp's `go`; the admin `finished` the last screen
 * of an onboarding that interviews nobody; or the company goes through
 * `no_onboarding` at all.
 */
export type GateOpening = "go" | "finished" | "no_onboarding";

/**
 * Opens the gate to everyone in the company: on Grasp's go, unless
 * `reason` says the company's flow opened it. On record with why. Every
 * session for an interview alone ends in the same batch: whoever had one
 * signs in again, and joins as a member.
 */
export const openGate = async (
  env: Env,
  by: AuditActor,
  reason: GateOpening = "go"
): Promise<void> => {
  const db = drizzle(env.DB);
  const results = await auditedBatch(env, db, [
    db
      .update(onboardingGate)
      // Grasp's go is given once: opening again keeps its time, so closing
      // and opening never moves the onboarding scope's cutoff.
      .set({
        closedAt: null,
        openedAt: sql`coalesce(${onboardingGate.openedAt}, ${Date.now()})`,
      })
      .where(
        and(eq(onboardingGate.id, gateRow), isNotNull(onboardingGate.closedAt))
      ),
    outboxedIfChanged(db, {
      actor: by,
      action: "onboarding.gate.opened",
      target: { type: "deployment", id: gateRow },
      detail: { reason },
    }),
    db
      .delete(sessions)
      .where(eq(sessions.interview, true))
      .returning({ userId: sessions.userId }),
  ]);
  identityChanged(
    env,
    results[2].map(({ userId }) => userId)
  );
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

/**
 * Opens the gate where the company's flow says it opens by itself, as
 * `by`, on what they just did. Staff who `set` the flow open it at once
 * where the company goes through no onboarding, and where nobody is
 * interviewed and its admin already finished every screen the flow has.
 * The admin who `finished` a screen opens it only where nobody is
 * interviewed, every screen is finished, and the gate was never opened
 * before: once it was, by a flow or on Grasp's go, closing it again is
 * staff's decision, and only staff undo it. Said again after an opening
 * that failed, it opens then. A flow with interviews opens only on
 * Grasp's go. Opening is all it does: a flow never closes the gate, and
 * an open gate is left as it is.
 */
export const openAsFlowSays = async (
  env: Env,
  by: AuditActor,
  on: "set" | "finished"
): Promise<void> => {
  const store = onboardingStore(env);
  const { flow } = await store.flow();
  const opening = flowOpening(flow);
  if (opening === "go" || (on === "finished" && opening !== "finished")) {
    return;
  }
  const { openedAt } = await stored(env);
  if (on === "finished" && openedAt !== null) {
    return;
  }
  if (opening === "finished") {
    const { done } = await store.place();
    if (!flowScreens(flow).every((screen) => done.includes(screen))) {
      return;
    }
  }
  await openGate(
    env,
    by,
    opening === "finished" ? "finished" : "no_onboarding"
  );
};
