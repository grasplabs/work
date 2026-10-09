import type { AuditEvent } from "@grasp-os/shared/audit";
import type { OnboardingView, Roster } from "@grasp-os/shared/onboarding";
import type { GateThreshold } from "@grasp-os/shared/onboarding-gate";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { gateView } from "../src/onboarding/gate.ts";
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
// - Anyone but staff closing or opening it, or doing so without a trace.

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
  const staff = await asStaff();
  await staff.onboardingGate.open();
};

describe("while the company is onboarding", () => {
  afterEach(reopen);

  it("lets in only the configured admins and staff: anyone else gets no user, no session, and the waiting page", async () => {
    const staff = await asStaff();
    await staff.onboardingGate.close();
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
    const { core } = await openRpc(staffSession);
    await core.authenticate().onboardingGate.close();
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
    const staff = await asStaff();
    const events = await auditedDuring(async () => {
      await staff.onboardingGate.close();
      // Closed twice is closed once.
      await staff.onboardingGate.close();
      await staff.onboardingGate.open();
    });
    const member = await signIn(idp, "microsoft", entraPerson(acmeTenant));
    expect(member.session).toBeDefined();
    expect(actionsOf(events)).toStrictEqual([
      "onboarding.gate.closed",
      "onboarding.gate.opened",
    ]);
    expect(events.map(({ actor }) => actor.type)).toStrictEqual([
      "staff",
      "staff",
    ]);
  });

  it("keeps when it was first given, through taking it back and giving it again", async () => {
    const staff = await asStaff();
    await staff.onboardingGate.close();
    const given = await staff.onboardingGate.open();
    const takenBack = await staff.onboardingGate.close();
    const again = await staff.onboardingGate.open();
    expect({
      given: given.openedAt !== null,
      takenBack: [takenBack.open, takenBack.openedAt === given.openedAt],
      again: again.openedAt === given.openedAt,
    }).toStrictEqual({ given: true, takenBack: [false, true], again: true });
  });

  it("is staff's alone: the company's admin reads the gate but can't move it", async () => {
    const { api } = await signedInApi(idp, "admin");
    const view = await api.onboardingGate.view();
    expect({
      open: view.open,
      threshold: view.threshold,
      close: await outcome(api.onboardingGate.close()),
      go: await outcome(api.onboardingGate.open()),
      threshold70: await outcome(api.onboardingGate.setThreshold(70)),
    }).toStrictEqual({
      open: true,
      threshold: 80,
      close: "onboarding.staff_only",
      go: "onboarding.staff_only",
      threshold70: "onboarding.staff_only",
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

  it("takes only the thresholds there are, from staff", async () => {
    const staff = await asStaff();
    const view = await staff.onboardingGate.setThreshold(70);
    expect(view.threshold).toBe(70);
    // Only the thresholds there are.
    // SAFETY: a threshold the type refuses, as a client could still send it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const unknownThreshold = 75 as GateThreshold;
    await expect(
      outcome(staff.onboardingGate.setThreshold(unknownThreshold))
    ).resolves.toBe("onboarding.invalid");
  });
});
