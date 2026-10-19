import {
  adminSnapshotMaxBytes,
  adminSnapshotMaxSkewMs,
  adminSnapshotPurpose,
  adminSnapshotRequestSchema,
  adminSnapshotSchema,
} from "@grasp-os/shared/admin-snapshot";
import type {
  AdminInterview,
  AdminLink,
  AdminSnapshot,
} from "@grasp-os/shared/admin-snapshot";
import { dayOf, METER_PURPOSES } from "@grasp-os/shared/admin/org-record";
import { authErrors, requestErrors } from "@grasp-os/shared/errors";
import { log } from "@grasp-os/shared/log";
import type { Plan } from "@grasp-os/shared/onboarding";

import { appendAuditEvent } from "./audit-outbox.ts";
import { organizationId } from "./auth/auth.ts";
import { signInConfig } from "./auth/config.ts";
import { consoleSigned } from "./console-signed.ts";
import { errorResponse } from "./errors.ts";
import { membersOf } from "./members.ts";
import { gateView, staffAccessEnded } from "./onboarding/gate.ts";
import { closesOn } from "./onboarding/rules.ts";
import { onboardingStore } from "./onboarding/store.ts";
import type { AdminInterviewFacts } from "./onboarding/store.ts";
import { readOrganization } from "./organization.ts";

// Grasp's admin's read of this client (GRA-638): everything its pages are
// worked out from, as `@grasp-os/shared/admin-snapshot` says, for Grasp's
// staff alone. What it can't let happen, and what stops it here:
//
// - Anyone but Grasp's staff reading it: a member, an admin of the
//   company, someone with an interview link, or anyone else. It isn't
//   behind `/rpc` or any session: only the console's signed request reads
//   it (console-signed.ts), with a key derived for this purpose alone from
//   this client's auth secret, so a session cookie or a link opens
//   nothing, and the console's key for another client signs nothing here.
// - A read the company can't see: every read is in its audit log, by the
//   staff member the console names, before anything is answered; when the
//   log can't take it, nothing is.
// - What anyone said reaching the console: interviews leave the store as
//   numbers (`Onboarding.adminFacts`), and the answer is only what the
//   schema names. Transcripts stay behind the audited staff transcript
//   read (onboarding/staff-rpc.ts).
//
// - Grasp reading on after the company said stop: once the company's
//   admin ends Grasp's staff access (onboarding/gate.ts), this read is
//   refused too, until the console opens a new staff window. It names
//   people and their emails, and ending staff access is the company's
//   one way to say no.

/** How long after its last save an interview still counts as going on. */
const talkingMs = 15 * 60 * 1000;

/**
 * Where someone stands, as the prototype's admin says it
 * (`personStateOf` in @grasp-os/shared/admin/org-record), from core's
 * records: their link, if it went out, and their interview, if any.
 * Not that function itself: it takes the prototype's records, a link with
 * its secret and a plan with its `told`, which core's rows don't carry.
 */
const linkStateOf = (
  link: { openedAt: string | null } | undefined,
  interview: AdminInterviewFacts | undefined,
  plan: Plan | null,
  now: string
): AdminLink["state"] => {
  if (link === undefined) {
    return "waiting";
  }
  if ((interview?.completedAt ?? null) !== null) {
    return "completed";
  }
  const over = plan !== null && dayOf(now) > closesOn(plan);
  const talked = (interview?.startedAt ?? null) !== null;
  if (over) {
    return talked ? "incomplete" : "expired";
  }
  if (interview !== undefined && talked) {
    const recent =
      Date.parse(now) - Date.parse(interview.updatedAt) < talkingMs;
    return interview.state === "progress" && recent ? "progress" : "incomplete";
  }
  return link.openedAt === null ? "invited" : "opened";
};

/** An interview as the admin reads it: its numbers, and where it stopped. */
const interviewOf = (facts: AdminInterviewFacts): AdminInterview => {
  const { startedAt, completedAt, updatedAt, phase } = facts;
  const agreed = completedAt !== null;
  return {
    person: facts.person,
    kind: facts.kind,
    startedAt,
    completedAt,
    updatedAt,
    agreed,
    phase,
    stoppedAt: !agreed && startedAt !== null ? phase : null,
    minutes:
      startedAt === null
        ? null
        : Math.max(
            0,
            Math.round(
              (Date.parse(completedAt ?? updatedAt) - Date.parse(startedAt)) /
                60_000
            )
          ),
    facts: facts.facts,
    out: facts.out,
    confirmed: facts.confirmed,
    rating: facts.rating,
    typed: facts.typed,
    interviewer: facts.interviewer,
  };
};

/** The AI the onboarding used, by day, then purpose, then model. */
const usageOf = (
  rows: {
    day: string;
    purpose: string;
    model: string;
    calls: number;
    tokensIn: number;
    tokensCached: number;
    tokensOut: number;
    seconds: number;
  }[]
): AdminSnapshot["usage"] => {
  const days = new Map<string, AdminSnapshot["usage"][number]["use"]>();
  for (const row of rows) {
    const purpose = METER_PURPOSES.find((each) => each === row.purpose);
    if (purpose === undefined) {
      continue;
    }
    const use = days.get(row.day) ?? {};
    use[purpose] = {
      ...use[purpose],
      [row.model]: {
        calls: row.calls,
        tokensIn: row.tokensIn,
        kept: row.tokensCached,
        tokensOut: row.tokensOut,
        seconds: row.seconds,
      },
    };
    days.set(row.day, use);
  }
  return [...days].map(([day, use]) => ({ day, use }));
};

/** Everything the admin reads of this client, from what core holds, at `now`. */
const snapshotOf = async (env: Env, now: string): Promise<AdminSnapshot> => {
  const store = onboardingStore(env);
  const view = await store.view(now);
  const [facts, agreements, usage, kickoff, gate, organization, members] =
    await Promise.all([
      store.adminFacts(),
      store.agreements(),
      store.usage(),
      store.kickoffFacts(),
      gateView(env, view, now),
      readOrganization(env),
      membersOf(env),
    ]);
  const config = signInConfig(env);
  const sent = new Map(facts.links.map((link) => [link.person, link]));
  const held = new Map(facts.interviews.map((one) => [one.person, one]));
  const links = (view.roster?.people ?? []).map(({ id }): AdminLink => {
    const link = sent.get(id);
    return {
      person: id,
      sentAt: link?.sentAt ?? null,
      openedAt: link?.openedAt ?? null,
      remindedAt: link?.remindedAt ?? null,
      deletedAt: link?.deletedAt ?? null,
      state: linkStateOf(link, held.get(id), view.plan, now),
    };
  });
  return {
    now,
    company: {
      name: organization.name,
      timeZone: organization.timeZone,
      signInDomains: organization.signInDomains,
      signIn: [
        ...(config?.entra === undefined ? [] : (["microsoft"] as const)),
        ...(config?.google === undefined ? [] : (["google"] as const)),
      ],
      admins: config?.admins ?? [],
    },
    contacts: null,
    roster: view.roster,
    plan: view.plan,
    agreements,
    agreed: view.agreed,
    paused: view.paused,
    told: facts.told,
    mapped: facts.mapped,
    links,
    interviews: facts.interviews.map(interviewOf),
    works: null,
    kickoff,
    gate: {
      open: gate.open,
      closedSince: gate.closedSince,
      threshold: gate.threshold,
      known: gate.known,
      ready: gate.ready,
      over: gate.over,
      openedAt: gate.openedAt,
    },
    contract: null,
    members,
    integrations: null,
    usage: usageOf(usage),
  };
};

/**
 * The console's request for the snapshot: 200 with it, once the request
 * is signed, fresh and well formed and its read is in the audit log. An
 * unsigned request, or one signed otherwise, is 401; one too large, stale
 * or malformed, or made after the company ended staff access, 403;
 * anything but a `POST` a path core doesn't serve.
 */
export const adminSnapshotResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  const asked = await consoleSigned(request, env, {
    purpose: adminSnapshotPurpose,
    schema: adminSnapshotRequestSchema,
    maxBytes: adminSnapshotMaxBytes,
    maxSkewMs: adminSnapshotMaxSkewMs,
  });
  if (typeof asked === "string") {
    log.info("admin.snapshot.refused", { reason: asked });
    return asked === "unsigned" || asked === "bad_signature"
      ? errorResponse(401, authErrors.create("auth.unauthenticated"), requestId)
      : errorResponse(
          403,
          requestErrors.create("request.forbidden"),
          requestId
        );
  }
  if (await staffAccessEnded(env, signInConfig(env)?.staff?.opened)) {
    log.info("admin.snapshot.refused", { reason: "staff_access_ended" });
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }
  // Only what the schema names leaves core, whatever was built.
  const snapshot = adminSnapshotSchema.parse(
    await snapshotOf(env, new Date().toISOString())
  );
  // On record before it is read; a log that can't take it fails the read.
  await appendAuditEvent(env, {
    actor: { type: "staff", userId: asked.staff.email, via: "console" },
    action: "admin.snapshot.read",
    target: { type: "organization", id: organizationId },
    requestId,
    detail: {},
  });
  return Response.json(snapshot, { headers: { "cache-control": "no-store" } });
};
