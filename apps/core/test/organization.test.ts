import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { signInConfig } from "./sign-in-config.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// The organization's name and time zone: everyone in it reads them, only
// its own admins change them. These tests start from the ways it can fail:
// someone other than an admin (Grasp staff included) changing them, a name
// or time zone that breaks what shows them, a change that leaves no
// record, and a record that carries the name.

const idp = mockIdp();

describe("the organization", () => {
  afterEach(async () => {
    await env.DB.prepare(
      "UPDATE organizations SET name = 'Organization', time_zone = NULL"
    ).run();
  });

  it("reads the same for everyone: its name, UTC until set, its region and sign-in domains", async () => {
    const person = await signedInApi(idp, "user");
    await expect(person.api.organization.get()).resolves.toStrictEqual({
      name: "Organization",
      timeZone: "UTC",
      dataRegion: "eu",
      signInDomains: signInConfig.domains,
    });
  });

  it("takes an admin's new name and time zone, and everyone reads them", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "builder");

    await expect(
      admin.api.organization.update({
        name: "  Acme Holding  ",
        timeZone: "Europe/Amsterdam",
      })
    ).resolves.toMatchObject({
      name: "Acme Holding",
      timeZone: "Europe/Amsterdam",
    });
    await admin.api.organization.update({ timeZone: "Europe/Berlin" });

    await expect(person.api.organization.get()).resolves.toMatchObject({
      name: "Acme Holding",
      timeZone: "Europe/Berlin",
    });
  });

  it("can't be changed by anyone but its own admins", async () => {
    const builder = await signedInApi(idp, "builder");
    await expect(
      outcome(builder.api.organization.update({ name: "Mine now" }))
    ).resolves.toBe("role.forbidden");

    const staff = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(staff);
    using api = core.authenticate();
    await expect(
      outcome(api.organization.update({ timeZone: "Europe/London" }))
    ).resolves.toBe("role.forbidden");

    await expect(builder.api.organization.get()).resolves.toMatchObject({
      name: "Organization",
      timeZone: "UTC",
    });
  });

  it("refuses a name or time zone that isn't one", async () => {
    const admin = await signedInApi(idp, "admin");
    const outcomes = await Promise.all([
      outcome(admin.api.organization.update({ name: "   " })),
      outcome(admin.api.organization.update({ name: "x".repeat(81) })),
      outcome(admin.api.organization.update({ name: "Two\nlines" })),
      outcome(admin.api.organization.update({ timeZone: "Europe/Atlantis" })),
      outcome(admin.api.organization.update({ timeZone: "" })),
    ]);
    expect(outcomes).toStrictEqual([
      "organization.name_invalid",
      "organization.name_invalid",
      "organization.name_invalid",
      "organization.time_zone_invalid",
      "organization.time_zone_invalid",
    ]);
    await expect(admin.api.organization.get()).resolves.toMatchObject({
      name: "Organization",
      timeZone: "UTC",
    });
  });

  it("records each change with who made it, without the name", async () => {
    const admin = await signedInApi(idp, "admin");
    const events = await auditedDuring(async () => {
      await admin.api.organization.update({ name: "Acme Secret Project" });
      await admin.api.organization.update({ timeZone: "Europe/Paris" });
      // Nothing changes, so nothing is recorded.
      await admin.api.organization.update({ timeZone: "Europe/Paris" });
    });

    expect(events).toStrictEqual([
      expect.objectContaining({
        action: "organization.updated",
        actor: { type: "person", userId: admin.userId },
        target: { type: "organization", id: "organization" },
        detail: { nameChanged: true },
      }),
      expect.objectContaining({
        action: "organization.updated",
        detail: { nameChanged: false, timeZone: "Europe/Paris" },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("Secret");
  });
});
