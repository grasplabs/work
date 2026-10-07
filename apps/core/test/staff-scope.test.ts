import { auditExportPath } from "@grasp-os/shared/audit-log";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { signInConfig } from "./sign-in-config.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
  withSignIn,
} from "./sign-in.ts";

// Grasp's staff on an onboarding (GRA-306, threat model S1 and S3): with
// the onboarding scope, a staff session reaches the onboarding and nothing
// else; it lasts until 7 days after Grasp's go; and the company's admin
// sees Grasp's access and can end it at once. The ways it can fail,
// tried here:
//
// - Staff with the onboarding scope reaching Knowledge, Apps, chats,
//   connections or the audit log, over `/rpc` or a route of its own.
// - Their access outliving the onboarding by more than a week.
// - The company unable to see or end it, or staff ending it for them.

const idp = mockIdp();

/** Core with staff given the onboarding scope. */
const onboardingScope = withSignIn({
  staff: { ...signInConfig.staff, scope: "onboarding" },
});

/** Staff, on a connection of their own, with `coreEnv`'s scope. */
const staffOn = async (coreEnv: Env = onboardingScope) => {
  const session = await signedIn(idp, "grasp-staff", staffPerson(), {
    coreEnv,
  });
  const { core } = await openRpc(session, { coreEnv });
  return { session, api: core.authenticate() };
};

/** Whether `session`'s staff member can still read who they are. */
const stillIn = async (session: string, coreEnv: Env): Promise<string> => {
  const { core } = await openRpc(session, { coreEnv });
  return await outcome(core.authenticate().whoami());
};

/** Every test leaves the gate as it found it: open, no go, nothing ended. */
const reset = async () => {
  await env.DB.prepare(
    "UPDATE onboarding_gate SET closed_at = NULL, opened_at = NULL, staff_ended_at = NULL"
  ).run();
};

describe("staff with the onboarding scope", () => {
  afterEach(reset);

  it("reach the onboarding and nothing else, over /rpc or a route", async () => {
    const { session, api } = await staffOn();
    const audit = await routed(
      `${auditExportPath}?format=csv`,
      {
        headers: { cookie: session },
      },
      onboardingScope
    );
    const who = await api.whoami();
    expect({
      who: who.onboardingOnly,
      onboarding: await outcome(api.onboarding.view()),
      gate: await outcome(api.onboardingGate.view()),
      apps: await outcome(api.apps.list()),
      chats: await outcome(api.chats.list()),
      members: await outcome(api.members.list()),
      audit: audit.status,
    }).toStrictEqual({
      who: true,
      onboarding: "ok",
      gate: "ok",
      apps: "role.forbidden",
      chats: "role.forbidden",
      members: "role.forbidden",
      audit: 401,
    });
  });

  it("keep their access until 7 days after Grasp's go, and not a day longer; full-scope staff keep theirs", async () => {
    const { session } = await staffOn();
    const { session: full } = await staffOn(env);
    const { api: staff } = await staffOn();
    await staff.onboardingGate.close();
    await staff.onboardingGate.open();
    const sixDays = Date.now() - 6 * 24 * 60 * 60 * 1000;
    await env.DB.prepare("UPDATE onboarding_gate SET opened_at = ?")
      .bind(sixDays)
      .run();
    const within = await stillIn(session, onboardingScope);
    const eightDays = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await env.DB.prepare("UPDATE onboarding_gate SET opened_at = ?")
      .bind(eightDays)
      .run();
    expect({
      within,
      after: await stillIn(session, onboardingScope),
      full: await stillIn(full, env),
    }).toStrictEqual({
      within: "ok",
      after: "auth.unauthenticated",
      full: "ok",
    });
  });
});

describe("staff with the onboarding scope, after Grasp's go", () => {
  afterEach(reset);

  it("don't get access back when the gate closes again, and see when theirs ends", async () => {
    const { session, api: staff } = await staffOn();
    await staff.onboardingGate.close();
    await staff.onboardingGate.open();
    const sixDays = Date.now() - 6 * 24 * 60 * 60 * 1000;
    await env.DB.prepare("UPDATE onboarding_gate SET opened_at = ?")
      .bind(sixDays)
      .run();
    const view = await staff.onboardingGate.view();
    await staff.onboardingGate.close();
    const eightDays = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await env.DB.prepare("UPDATE onboarding_gate SET opened_at = ?")
      .bind(eightDays)
      .run();
    const again = await outcome(
      signedIn(idp, "grasp-staff", staffPerson(), { coreEnv: onboardingScope })
    );
    expect({
      until: view.staff?.until,
      after: await stillIn(session, onboardingScope),
      again: again.startsWith("Error: Sign-in refused") ? "refused" : again,
    }).toStrictEqual({
      until: new Date(sixDays + 7 * 24 * 60 * 60 * 1000).toISOString(),
      after: "auth.unauthenticated",
      again: "refused",
    });
  });
});

describe("the company's admin", () => {
  afterEach(reset);

  it("sees Grasp's staff access, and ends it at once and on record; staff can't end it for them", async () => {
    const { api: admin } = await signedInApi(idp, "admin");
    const { session, api: staff } = await staffOn(env);
    const seen = await admin.onboardingGate.view();
    const byStaff = await outcome(staff.onboardingGate.endStaffAccess());
    const events = await auditedDuring(async () => {
      await admin.onboardingGate.endStaffAccess();
    });
    const after = await admin.onboardingGate.view();
    const again = await outcome(signedIn(idp, "grasp-staff", staffPerson()));
    expect({
      seen: { open: seen.staff?.open, scope: seen.staff?.scope },
      byStaff,
      ended: await stillIn(session, env),
      again: again.startsWith("Error: Sign-in refused") ? "refused" : again,
      actions: events.map(({ action, actor }) => [action, actor.type]),
      after: after.staff?.open,
    }).toStrictEqual({
      seen: { open: true, scope: "full" },
      byStaff: "role.forbidden",
      ended: "auth.unauthenticated",
      again: "refused",
      actions: [["onboarding.staff_access.ended", "person"]],
      after: false,
    });
  });
});
