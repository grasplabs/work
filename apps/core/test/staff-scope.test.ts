import { auditExportPath } from "@grasp-os/shared/audit-log";
import { appTokenPath } from "@grasp-os/shared/portable";
import { appFunctionPath, screenPersonHeader } from "@grasp-os/shared/screens";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { finished } from "./runs.ts";
import { acmeTenant, clientOrigin, signInConfig } from "./sign-in-config.ts";
import {
  auditedDuring,
  entraPerson,
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
  whoami,
  withSignIn,
} from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// Grasp's staff on a client's deployment (GRA-306; Nick, 2026-11-01): a
// staff sign-in is for managing a deployment, never for acting inside the
// client's workspace. Whatever the staff scope, a staff session reaches
// the onboarding and nothing else; staff who need to act in the workspace
// are added as members and sign in as one. With the onboarding scope, the
// access also lasts only until 7 days after Grasp's go; and the company's
// admin sees Grasp's access and can end it at once. The ways it can fail,
// tried here:
//
// - A staff session acting in the workspace: starting a run, asking in a
//   chat, calling an App's function, creating an App, writing Knowledge
//   or the Brain, over `/rpc` or a route of its own (an App's function
//   route, an App token for a portable host).
// - A staff session reading the workspace: Apps, chats, members,
//   Knowledge, the audit log.
// - A staff session losing the onboarding it is there to run.
// - Staff added as a member unable to act as one.
// - Onboarding-scope access outliving the onboarding by more than a week.
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

/** A JSON post from the deployment's own page with `cookie`: its status. */
const postedAs = async (
  path: string,
  cookie: string,
  headers: Record<string, string> = {}
): Promise<number> => {
  const response = await routed(path, {
    method: "POST",
    headers: {
      cookie,
      origin: clientOrigin,
      "content-type": "application/json",
      ...headers,
    },
    body: "{}",
  });
  return response.status;
};

/** How many runs of `app` anyone started, as core keeps them. */
const runsOf = async (app: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS runs FROM workflow_runs WHERE app_id = ?"
  )
    .bind(app)
    .first<{ runs: number }>();
  return row?.runs ?? 0;
};

/** An App of a new builder's with one workflow, `report`, that finishes. */
const reportApp = async (): Promise<string> => {
  const builder = await signedInApi(idp, "builder");
  return await appWith(
    builder,
    workflowFiles(
      "report",
      `  return await step.do("total", { description: "Read" }, async () => 1);`,
      { total: 1 }
    )
  );
};

describe("a Grasp staff session, whatever its scope", () => {
  afterEach(reset);

  it("reaches the onboarding and nothing else, over /rpc or a route", async () => {
    const reach = async (coreEnv: Env) => {
      const { session, api } = await staffOn(coreEnv);
      const audit = await routed(
        `${auditExportPath}?format=csv`,
        { headers: { cookie: session } },
        coreEnv
      );
      const who = await api.whoami();
      return {
        who: { staff: who.staff, onboardingOnly: who.onboardingOnly },
        onboarding: await outcome(api.onboarding.view()),
        gate: await outcome(api.onboardingGate.view()),
        apps: await outcome(api.apps.list()),
        chats: await outcome(api.chats.list()),
        members: await outcome(api.members.list()),
        knowledge: await outcome(api.knowledge.listCollections()),
        auditLog: await outcome(api.audit.search()),
        emailPreferences: await outcome(api.emailPreferences.get()),
        waiting: await outcome(api.waiting.list()),
        audit: audit.status,
      };
    };
    const reached = {
      who: { staff: true, onboardingOnly: true },
      onboarding: "ok",
      gate: "ok",
      apps: "role.forbidden",
      chats: "role.forbidden",
      members: "role.forbidden",
      knowledge: "role.forbidden",
      auditLog: "role.forbidden",
      emailPreferences: "role.forbidden",
      waiting: "role.forbidden",
      audit: 401,
    };
    expect({
      full: await reach(env),
      onboarding: await reach(onboardingScope),
    }).toStrictEqual({ full: reached, onboarding: reached });
  });

  it("starts no run, asks no chat, calls no App function, creates no App and writes no Knowledge or Brain", async () => {
    const app = await reportApp();
    const { session, api } = await staffOn(env);
    const { userId } = await api.whoami();
    const asScreen = { [screenPersonHeader]: userId };

    expect({
      run: await outcome(api.workflows.start(app, "report")),
      chat: await outcome(api.chats.create("Check")),
      send: await outcome(
        api.chats.send(crypto.randomUUID(), { text: "Hi", model: "any" })
      ),
      createApp: await outcome(api.apps.create({ name: "Staff's" })),
      collection: await outcome(
        api.knowledge.createCollection({ name: "Staff's", access: "everyone" })
      ),
      brain: await outcome(api.brain.addRecords([])),
      screen: await outcome(api.screens.open(app, "main")),
      functions: await postedAs(`${appFunctionPath}/${app}`, session, asScreen),
      stream: await postedAs(
        `${appFunctionPath}/${app}/stream`,
        session,
        asScreen
      ),
      token: await postedAs(`${appTokenPath}/${app}`, session),
      runs: await runsOf(app),
    }).toStrictEqual({
      run: "role.forbidden",
      chat: "role.forbidden",
      send: "role.forbidden",
      createApp: "role.forbidden",
      collection: "role.forbidden",
      brain: "role.forbidden",
      screen: "role.forbidden",
      functions: 401,
      stream: 401,
      token: 401,
      runs: 0,
    });
  });
});

describe("a Grasp staff member added as a member", () => {
  it("acts as that member when signed in as one, as their staff session can't", async () => {
    const app = await reportApp();
    const { api: staff } = await staffOn(env);
    const added = entraPerson(acmeTenant, "acme.test", {
      name: "Grasp staff, added as a member",
    });
    const session = await signedIn(idp, "microsoft", added, {
      coreEnv: withSignIn({ admins: [added.email] }),
    });
    const { core } = await openRpc(session);
    const member = core.authenticate();

    const byStaff = await outcome(staff.workflows.start(app, "report"));
    const run = await member.workflows.start(app, "report");
    await finished(run.id);
    const { status } = await member.workflows.status(run.id);
    const who = await whoami(session);

    expect({
      byStaff,
      member: { staff: who.staff, onboardingOnly: who.onboardingOnly, status },
    }).toStrictEqual({
      byStaff: "role.forbidden",
      member: { staff: false, onboardingOnly: undefined, status: "completed" },
    });
  });
});

describe("staff with the onboarding scope", () => {
  afterEach(reset);

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

  it("don't get access back when the gate closes and opens again, and see when theirs ends", async () => {
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
    // Opening again, by staff with the full scope, keeps the go's time.
    const { api: full } = await staffOn(env);
    await full.onboardingGate.open();
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
