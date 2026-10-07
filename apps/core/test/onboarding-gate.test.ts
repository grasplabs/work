import type { AuditEvent } from "@grasp-os/shared/audit";
import type { GateThreshold } from "@grasp-os/shared/onboarding-gate";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

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

  it("is ready once Grasp knows as much as staff set, from what the onboarding holds", async () => {
    const staff = await asStaff();
    const view = await staff.onboardingGate.setThreshold(70);
    expect({
      threshold: view.threshold,
      ready: view.ready,
      parts: view.parts.map(({ source }) => source),
    }).toStrictEqual({
      threshold: 70,
      ready: view.known >= 70,
      parts: [
        "kickoff",
        "people",
        "sources",
        "documents",
        "tools",
        "leads",
        "conversations",
        "review",
      ],
    });
    // Only the thresholds there are.
    // SAFETY: a threshold the type refuses, as a client could still send it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const unknownThreshold = 75 as GateThreshold;
    await expect(
      outcome(staff.onboardingGate.setThreshold(unknownThreshold))
    ).resolves.toBe("onboarding.invalid");
  });
});
