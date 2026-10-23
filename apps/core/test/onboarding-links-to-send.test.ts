import type { RosterInput } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// The links the company's admin takes to send themselves (GRA-357), over
// `/rpc`: everyone who takes part, with their own link once it is out, and
// which are new since the admin last took some. What it must not let
// happen: a link before it is out, anyone but an admin taking the links,
// or the audit log naming whose links were taken.

const idp = mockIdp();

/** A name nobody else uses, to look for where it must not be. */
const sentinel = "Zebulon Quillfeather";

/** Sales, led by Lea; Ops without a lead, with Oli away; Legal not taking part. */
const roster: RosterInput = {
  teams: [
    { id: "sales", name: "Sales", lead: "lea" },
    { id: "ops", name: "Ops", lead: null },
    { id: "legal", name: "Legal", lead: null, off: true },
  ],
  people: [
    { id: "lea", name: sentinel, email: "lea@acme.test", team: "sales" },
    { id: "sam", name: "Sam", email: "sam@acme.test", team: "sales" },
    { id: "ona", name: "Ona", team: "ops" },
    { id: "oli", name: "Oli", team: "ops", away: true },
    { id: "lex", name: "Lex", team: "legal" },
  ],
};

const today = () => new Date().toISOString().slice(0, 10);

/** The leads' links, and a team without a lead, go out at once. */
const started = async () => {
  const { api, userId } = await signedInApi(idp, "admin");
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  const staff = core.authenticate();
  await api.onboarding.saveRoster(roster);
  await api.onboarding.savePlan({ start: today() });
  await staff.onboardingStaff.setAgreements({
    processing: true,
    assessment: true,
    council: "none",
  });
  await onboardingStore(env).releaseDue();
  return { api, userId };
};

/** A link's path: the interview page, its secret after the `#`. */
const linkPath = /^\/interview#[A-Za-z0-9_-]{43}$/u;

describe("the links the admin sends", () => {
  it("list everyone who takes part, with their link once it is out, as new", async () => {
    const { api } = await started();
    const listed = await api.onboarding.links();
    expect(
      listed.map(({ person, team, email, path, fresh }) => ({
        person,
        team,
        email,
        out: path !== null && linkPath.test(path),
        fresh,
      }))
    ).toStrictEqual([
      {
        person: "lea",
        team: "Sales",
        email: "lea@acme.test",
        out: true,
        fresh: true,
      },
      // Sam's waits for Lea.
      {
        person: "sam",
        team: "Sales",
        email: "sam@acme.test",
        out: false,
        fresh: false,
      },
      { person: "ona", team: "Ops", email: "", out: true, fresh: true },
    ]);
  });

  it("are new no more once taken, and the audit log has how many, never whose", async () => {
    const { api, userId } = await started();
    const events = await auditedDuring(async () => {
      // Sam's isn't out: taking it changes nothing.
      await api.onboarding.linksTaken(["lea", "sam"]);
    });
    const listed = await api.onboarding.links();
    const taken = events.filter(
      ({ action }) => action === "onboarding.links.taken"
    );
    expect({
      fresh: listed.filter(({ fresh }) => fresh).map(({ person }) => person),
      taken: taken.map(({ actor, detail }) => ({
        by: actor.type === "person" ? actor.userId : actor.type,
        detail,
      })),
      named: JSON.stringify(taken).includes(sentinel),
    }).toStrictEqual({
      fresh: ["ona"],
      taken: [{ by: userId, detail: { count: 1 } }],
      named: false,
    });
  });

  it("give the same link each time, so taking it again sends nobody a second one", async () => {
    const { api } = await started();
    const first = await api.onboarding.links();
    await api.onboarding.linksTaken(first.map(({ person }) => person));
    const again = await api.onboarding.links();
    expect(again.map(({ path }) => path)).toStrictEqual(
      first.map(({ path }) => path)
    );
  });

  it("are the admins' alone", async () => {
    await started();
    const { api } = await signedInApi(idp, "user");
    await expect(
      Promise.all([
        outcome(api.onboarding.links()),
        outcome(api.onboarding.linksTaken(["lea"])),
      ])
    ).resolves.toStrictEqual(["role.forbidden", "role.forbidden"]);
  });

  it("refuses what isn't a list of people", async () => {
    const { api } = await started();
    await expect(
      outcome(api.onboarding.linksTaken(["not a person id"]))
    ).resolves.toBe("onboarding.invalid");
  });
});
