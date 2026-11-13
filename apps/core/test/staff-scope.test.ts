import { auditExportPath } from "@grasp-os/shared/audit-log";
import { appFunctionPath, pagePersonHeader } from "@grasp-os/shared/pages";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { adminCommands } from "./admin-command.ts";
import { mockIdp } from "./idp.ts";
import {
  endedRun,
  greetingTasks,
  jsonWorkflowAppsOf,
  publishedWorkflow,
} from "./json-workflow-apps.ts";
import type { Person } from "./json-workflow-apps.ts";
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
  unique,
  whoami,
  withSignIn,
} from "./sign-in.ts";

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
//   route).
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

const { signedIn: signedInPerson } = jsonWorkflowAppsOf(idp);

/** How many runs of workflow `id` there are, as its builder lists them. */
const runsOf = async (builder: Person, id: string): Promise<number> => {
  const runs = await builder.api.workflowResources.runs(id);
  return runs.length;
};

/** A new builder's App, and their independent workflow that finishes. */
const reportWorkflow = async () => {
  const builder = await signedInPerson("builder");
  const { id: app } = await builder.api.apps.create({ name: "Reports" });
  const workflow = await publishedWorkflow(builder, greetingTasks());
  return { builder, app, workflow: workflow.id };
};

/** A start of version 1, under a key of its own, as a session starts one. */
const startOf = () => ({
  version: 1,
  args: { who: "Ada" },
  key: unique(),
});

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
      waiting: "role.forbidden",
      audit: 401,
    };
    expect({
      full: await reach(env),
      onboarding: await reach(onboardingScope),
    }).toStrictEqual({ full: reached, onboarding: reached });
  });

  it("starts no run, asks no chat, calls no App function, creates no App and writes no Knowledge or Brain", async () => {
    const { builder, app, workflow } = await reportWorkflow();
    const { session, api } = await staffOn(env);
    const { userId } = await api.whoami();
    const asPage = { [pagePersonHeader]: userId };

    expect({
      run: await outcome(api.workflowResources.start(workflow, startOf())),
      chat: await outcome(api.chats.create("Check")),
      send: await outcome(
        api.chats.send(crypto.randomUUID(), { text: "Hi", model: "any" })
      ),
      createApp: await outcome(api.apps.create({ name: "Staff's" })),
      collection: await outcome(
        api.knowledge.createCollection({ name: "Staff's", access: "everyone" })
      ),
      brain: await outcome(api.brain.addRecords([])),
      page: await outcome(api.pages.open(app)),
      functions: await postedAs(`${appFunctionPath}/${app}`, session, asPage),
      stream: await postedAs(
        `${appFunctionPath}/${app}/stream`,
        session,
        asPage
      ),
      runs: await runsOf(builder, workflow),
    }).toStrictEqual({
      run: "role.forbidden",
      chat: "role.forbidden",
      send: "role.forbidden",
      createApp: "role.forbidden",
      collection: "role.forbidden",
      brain: "role.forbidden",
      page: "role.forbidden",
      functions: 401,
      stream: 401,
      runs: 0,
    });
  });
});

describe("a Grasp staff member added as a member", () => {
  it("acts as that member when signed in as one, as their staff session can't", async () => {
    const { builder, workflow } = await reportWorkflow();
    const { api: staff } = await staffOn(env);
    const added = entraPerson(acmeTenant, "acme.test", {
      name: "Grasp staff, added as a member",
    });
    const session = await signedIn(idp, "microsoft", added, {
      coreEnv: withSignIn({ admins: [added.email] }),
    });
    const { core } = await openRpc(session);
    const member = core.authenticate();
    const who = await whoami(session);
    await builder.api.workflowResources.members.add(workflow, {
      type: "person",
      id: who.userId,
      role: "user",
    });

    const byStaff = await outcome(
      staff.workflowResources.start(workflow, startOf())
    );
    const { runId } = await member.workflowResources.start(workflow, startOf());
    const { status } = await endedRun(builder, workflow, runId);

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
    await adminCommands().close();
    await adminCommands().open();
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
    await adminCommands().close();
    await adminCommands().open();
    const sixDays = Date.now() - 6 * 24 * 60 * 60 * 1000;
    await env.DB.prepare("UPDATE onboarding_gate SET opened_at = ?")
      .bind(sixDays)
      .run();
    const view = await staff.onboardingGate.view();
    await adminCommands().close();
    const eightDays = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await env.DB.prepare("UPDATE onboarding_gate SET opened_at = ?")
      .bind(eightDays)
      .run();
    // Opening again, from Grasp's admin, keeps the go's time.
    await adminCommands().open();
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
