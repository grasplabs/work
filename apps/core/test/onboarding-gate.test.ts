import type { AuditEvent } from "@grasp-os/shared/audit";
import type { OnboardingView, Roster } from "@grasp-os/shared/onboarding";
import { noContext } from "@grasp-os/shared/onboarding-context";
import {
  defaultFlow,
  flowPresets,
  flowScreens,
  setupSteps,
} from "@grasp-os/shared/onboarding-flow";
import type { GateThreshold } from "@grasp-os/shared/onboarding-gate";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { gateView } from "../src/onboarding/gate.ts";
import { adminCommands, adminSnapshot } from "./admin-command.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant } from "./sign-in-config.ts";
import {
  auditedDuring,
  entraPerson,
  openRpc,
  outcome,
  refusal,
  signIn,
  signedIn,
  signedInApi,
  staffPerson,
  whoami,
} from "./sign-in.ts";

// The gate of a deployment that is onboarding (src/onboarding/gate.ts):
// while it is closed, only the admins named in `SIGN_IN` and Grasp's staff
// come in. From the threat model (GRA-307, W10), the ways it can fail,
// tried here:
//
// - Someone in the company signing in before Grasp's go, or keeping a
//   session from before the gate closed.
// - Closing or opening it without a trace of the staff member, from
//   Grasp's admin (admin-command.ts tries who may give a command).

const idp = mockIdp();

/** The admin `SIGN_IN` names in the tests' config: one account, every time. */
const theAdmin = entraPerson(acmeTenant, "acme.test", {
  email: "ada@acme.test",
});
const configuredAdmin = () => theAdmin;

/** The ISO day `offset` days from today. */
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** Grasp's staff, on a connection of their own. */
const asStaff = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return await core.authenticate();
};

/** Whether `cookie`'s session still opens the platform. */
const signedInStill = async (cookie: string): Promise<boolean> =>
  (await refusal(whoami(cookie))) === "ok";

const actionsOf = (events: AuditEvent[]) => events.map(({ action }) => action);

/** Every test leaves the deployment open, as it found it. */
const reopen = async () => {
  await adminCommands().open();
};

/** The gate as Grasp's admin reads it, in the snapshot. */
const gateNow = async () => {
  const { gate } = await adminSnapshot();
  return gate;
};

describe("while the company is onboarding", () => {
  afterEach(reopen);

  it("lets in only the configured admins and staff: anyone else gets no user, no session, and the waiting page", async () => {
    await adminCommands().close();
    const member = entraPerson(acmeTenant);
    const refused = await signIn(idp, "microsoft", member);
    const admin = await signIn(idp, "microsoft", configuredAdmin());
    const { results } = await env.DB.prepare(
      "SELECT id FROM users WHERE email = ?"
    )
      .bind(member.email)
      .all();
    expect({
      session: refused.session,
      error: new URL(refused.location ?? "", "https://x.test").searchParams.get(
        "error"
      ),
      users: results.length,
      admin: admin.session !== undefined,
      staff: (await asStaff()) !== undefined,
    }).toStrictEqual({
      session: undefined,
      error: "not_open_yet",
      users: 0,
      admin: true,
      staff: true,
    });
  });

  it("ends the sessions from before it closed, but staff's and the admins'", async () => {
    const member = await signedIn(idp, "microsoft", entraPerson(acmeTenant));
    const admin = await signedIn(idp, "microsoft", configuredAdmin());
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    await adminCommands().close();
    expect({
      member: await signedInStill(member),
      admin: await signedInStill(admin),
      staff: await signedInStill(staffSession),
    }).toStrictEqual({ member: false, admin: true, staff: true });
  });
});

describe("Grasp's go", () => {
  afterEach(reopen);

  it("lets everyone in, and closing and opening are on record as the staff member", async () => {
    const commands = adminCommands();
    const events = await auditedDuring(async () => {
      await commands.close();
      // Closed twice is closed once.
      await commands.close();
      await commands.open();
    });
    const member = await signIn(idp, "microsoft", entraPerson(acmeTenant));
    expect(member.session).toBeDefined();
    // Every command is on record as given, the one that changed nothing too.
    expect(actionsOf(events)).toStrictEqual([
      "admin.command",
      "onboarding.gate.closed",
      "admin.command",
      "admin.command",
      "onboarding.gate.opened",
    ]);
    expect(new Set(events.map(({ actor }) => actor.type))).toStrictEqual(
      new Set(["staff"])
    );
  });

  it("keeps when it was first given, through taking it back and giving it again", async () => {
    const commands = adminCommands();
    await commands.close();
    await commands.open();
    const given = await gateNow();
    await commands.close();
    const takenBack = await gateNow();
    await commands.open();
    const again = await gateNow();
    expect({
      given: given.openedAt !== null,
      takenBack: [takenBack.open, takenBack.openedAt === given.openedAt],
      again: again.openedAt === given.openedAt,
    }).toStrictEqual({ given: true, takenBack: [false, true], again: true });
  });

  it("is read by the company's admin, never by a member", async () => {
    const { api } = await signedInApi(idp, "admin");
    const view = await api.onboardingGate.view();
    expect({ open: view.open, threshold: view.threshold }).toStrictEqual({
      open: true,
      threshold: 80,
    });
    const { api: user } = await signedInApi(idp, "user");
    await expect(outcome(user.onboardingGate.view())).resolves.toBe(
      "role.forbidden"
    );
  });

  it("is ready once Grasp knows as much as staff set, or once the interviews are over, and not on their last day", async () => {
    const now = new Date().toISOString();
    const roster: Roster = {
      teams: [
        { id: "sales", name: "Sales", lead: "lea", does: "", off: false },
        { id: "ops", name: "Ops", lead: "oli", does: "", off: false },
      ],
      people: [],
    };
    const view = (plan: OnboardingView["plan"]): OnboardingView => ({
      roster,
      plan,
      agreed: true,
      paused: false,
      sponsor: null,
      context: noContext,
      waiting: 0,
      mailSends: true,
      mailDomain: null,
      progress: {
        teams: [],
        // Both leads talked; half of the others did.
        leadsTalked: 2,
        leads: 2,
        talked: 5,
        asked: 10,
        asOf: day(0),
      },
    });
    // The people list (15), every team led (10), the conversations: the
    // leads' half whole and the others' half at a half (30 × 0.75).
    const lastDay = await gateView(
      env,
      view({ start: day(-13), days: 14 }),
      now
    );
    const over = await gateView(env, view({ start: day(-14), days: 14 }), now);
    expect({
      known: lastDay.known,
      parts: lastDay.parts.map(({ source, known }) => [source, known]),
      lastDay: [lastDay.ready, lastDay.over],
      over: [over.ready, over.over],
    }).toStrictEqual({
      known: 48,
      parts: [
        ["kickoff", 0],
        ["people", 1],
        ["sources", 0],
        ["documents", 0],
        ["tools", 0],
        ["leads", 1],
        ["conversations", 0.75],
        ["review", 0],
      ],
      lastDay: [false, false],
      over: [true, true],
    });
  });

  it("counts what Grasp knows against what the company's flow asks it for, so a step that is off can't hold it down", async () => {
    const now = new Date().toISOString();
    const roster: Roster = {
      teams: [{ id: "ops", name: "Ops", lead: "oli", does: "", off: false }],
      people: [],
    };
    const view: OnboardingView = {
      roster,
      plan: { start: day(-3), days: 14 },
      agreed: true,
      paused: false,
      sponsor: null,
      context: noContext,
      waiting: 0,
      mailSends: true,
      mailDomain: null,
      progress: {
        teams: [],
        leadsTalked: 1,
        leads: 1,
        talked: 5,
        asked: 10,
        asOf: day(0),
      },
    };
    const whole = await gateView(env, view, now);
    // No kickoff, no documents and no tools asked of this company.
    await adminCommands().setFlow({
      ...defaultFlow,
      steps: defaultFlow.steps.map((step) =>
        step.id === "documents" || step.id === "pulse"
          ? { ...step, on: false }
          : step
      ),
      grasp: { ...defaultFlow.grasp, kickoff: false },
    });
    const asked = await gateView(env, view, now);
    // Nothing asked at all: nothing is left to know.
    await adminCommands().setFlow({ ...defaultFlow, on: false });
    const none = await gateView(env, view, now);
    await adminCommands().setFlow(null);
    const back = await gateView(env, view, now);
    expect({
      // The people (15), every team led (10) and three quarters of the conversations (22.5), of 100.
      whole: whole.known,
      // The same 47.5, of the 70 its flow asks for.
      asked: asked.known,
      sources: asked.parts.map(({ source }) => source),
      none: [none.known, none.parts],
      back: back.known,
    }).toStrictEqual({
      whole: 48,
      asked: 68,
      sources: ["people", "sources", "leads", "conversations", "review"],
      none: [100, []],
      back: 48,
    });
  });

  it("takes only the thresholds there are, from Grasp's admin", async () => {
    await adminCommands().setThreshold(70);
    const set = await gateNow();
    // Only the thresholds there are.
    // SAFETY: a threshold the type refuses, as a client could still send it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const unknownThreshold = 75 as GateThreshold;
    const refused = await outcome(
      adminCommands().setThreshold(unknownThreshold)
    );
    await adminCommands().setThreshold(80);
    expect({ threshold: set.threshold, refused }).toStrictEqual({
      threshold: 70,
      // A command the admin couldn't have made is refused whole.
      refused: "request.forbidden",
    });
  });
});

/** Why the gate opened, and as whom, from what was on record meanwhile. */
const openings = (events: AuditEvent[]) =>
  events
    .filter(({ action }) => action === "onboarding.gate.opened")
    .map(({ actor, detail }) => [actor.type, detail.reason]);

// How a company's Grasp opens by its flow (`openAsFlowSays`). The ways it
// can go wrong, tried here:
//
// - Opening to the whole company before its admin finished an onboarding
//   that interviews nobody, or at all while people are still to be
//   interviewed, without Grasp's go.
// - A flow closing a Grasp that is open, or leaving one closed that goes
//   through no onboarding.
// - An opening with no trace of who caused it, or why.
describe("a company's Grasp opening by its flow", { timeout: 60_000 }, () => {
  // A gate never opened before, as a company's is as its onboarding
  // starts: one opened once is only staff's to open again.
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM onboarding_gate").run();
  });

  afterEach(async () => {
    await adminCommands().setFlow(null);
    await reopen();
  });

  /** The configured admin, on a connection of their own. */
  const asAdmin = async () => {
    const session = await signedIn(idp, "microsoft", configuredAdmin());
    const { core } = await openRpc(session);
    return await core.authenticate();
  };

  it("opens once its admin finished the last screen of an onboarding that interviews nobody, and not a screen sooner", async () => {
    const commands = adminCommands();
    await commands.close();
    await commands.setFlow(flowPresets.setup);
    const admin = await asAdmin();
    const afterFlow = await gateNow();

    const events = await auditedDuring(async () => {
      await admin.onboarding.finishSteps([
        "welcome",
        "ai",
        "company",
        "sources",
      ]);
    });
    const oneLeft = await gateNow();
    const last = await auditedDuring(async () => {
      await admin.onboarding.finishSteps(["documents"]);
    });
    const finished = await gateNow();
    const member = await signIn(idp, "microsoft", entraPerson(acmeTenant));

    expect({
      afterFlow: afterFlow.open,
      oneLeft: oneLeft.open,
      finished: finished.open,
      openings: openings([...events, ...last]),
      member: member.session !== undefined,
    }).toStrictEqual({
      afterFlow: false,
      oneLeft: false,
      finished: true,
      openings: [["person", "finished"]],
      member: true,
    });
  });

  it("stays closed once staff closed it again, whatever its admin says they finished", async () => {
    const commands = adminCommands();
    await commands.close();
    await commands.setFlow(flowPresets.setup);
    const admin = await asAdmin();
    await admin.onboarding.finishSteps(flowScreens(flowPresets.setup));
    const opened = await gateNow();
    await commands.close();

    const events = await auditedDuring(async () => {
      await admin.onboarding.finishSteps([]);
      await admin.onboarding.finishSteps(flowScreens(flowPresets.setup));
      // A screen its flow doesn't have, finished now: still staff's to open.
      await admin.onboarding.finishSteps(["pulse"]);
    });
    const closed = await gateNow();
    const member = await signIn(idp, "microsoft", entraPerson(acmeTenant));

    expect({
      opened: opened.open,
      closed: closed.open,
      openings: openings(events),
      member: member.session,
    }).toStrictEqual({
      opened: true,
      closed: false,
      openings: [],
      member: undefined,
    });
  });

  it("stays closed until Grasp's go while people are to be interviewed, whatever its admin finished", async () => {
    const commands = adminCommands();
    await commands.close();
    const admin = await asAdmin();
    await admin.onboarding.finishSteps([...setupSteps]);
    const closed = await gateNow();
    const member = await signIn(idp, "microsoft", entraPerson(acmeTenant));
    const events = await auditedDuring(async () => {
      await commands.open();
    });
    expect({
      closed: closed.open,
      member: member.session,
      openings: openings(events),
    }).toStrictEqual({
      closed: false,
      member: undefined,
      openings: [["staff", "go"]],
    });
  });

  it("opens at once where the company goes through no onboarding, and a flow never closes an open one", async () => {
    const commands = adminCommands();
    await commands.close();
    const events = await auditedDuring(async () => {
      await commands.setFlow(flowPresets.none);
    });
    const opened = await gateNow();
    // The whole onboarding again, for a company that is open: it stays open.
    await commands.setFlow(null);
    const still = await gateNow();
    expect({
      opened: opened.open,
      still: still.open,
      openings: openings(events),
    }).toStrictEqual({
      opened: true,
      still: true,
      openings: [["staff", "no_onboarding"]],
    });
  });
});
