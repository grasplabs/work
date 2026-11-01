import { noBilling, quietPulse } from "@grasp-os/shared/org-settings";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { entraClient, googleClient, signInConfig } from "./sign-in-config.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// The organization's billing and Pulse settings (src/org-settings.ts).
// These tests start from the ways they can fail: someone but an admin
// reading them (a billing address, a VAT number), someone but the
// organization's own admins (Grasp staff included) changing them, a value
// that breaks what shows it, a change that leaves no record, and a record
// that carries the values themselves.

const idp = mockIdp();

/** An email nobody else uses, to look for where it must not be. */
const sentinel = "finance-peregrine@acme.test";

const billing = {
  email: sentinel,
  company: "  Acme Holding B.V. ",
  address: "Keizersgracht 1\n1015 CJ Amsterdam",
  vatNumber: "nl123456789b01",
  emailInvoices: true,
  emailReceipts: false,
};

/** Pulse reporting on weekdays from nine to five. */
const officeHours = {
  schedule: Array.from({ length: 7 }, (_, day) =>
    Array.from({ length: 24 }, (__, hour) => day < 5 && hour >= 9 && hour < 17)
  ),
  employeeDomains: ["acme.test", "acme-old.test"],
};

describe("the organization's settings", () => {
  afterEach(async () => {
    await env.DB.prepare("DELETE FROM org_settings").run();
  });

  it("read as unset until an admin saves them, then as saved", async () => {
    const admin = await signedInApi(idp, "admin");
    const unset = await Promise.all([
      admin.api.orgSettings.billing(),
      admin.api.orgSettings.pulse(),
    ]);

    await admin.api.orgSettings.updateBilling(billing);
    await admin.api.orgSettings.updatePulse(officeHours);

    expect({
      unset,
      billing: await admin.api.orgSettings.billing(),
      pulse: await admin.api.orgSettings.pulse(),
    }).toStrictEqual({
      unset: [noBilling, quietPulse],
      billing: {
        ...billing,
        company: "Acme Holding B.V.",
        vatNumber: "NL123456789B01",
      },
      pulse: officeHours,
    });
  });

  it("are read and changed by the organization's own admins alone", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const member = await signedInApi(idp, "user");
    await admin.api.orgSettings.updateBilling(billing);
    const staff = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(staff);
    using staffApi = core.authenticate();

    expect({
      builder: await outcome(builder.api.orgSettings.billing()),
      member: await outcome(member.api.orgSettings.pulse()),
      staffReads: await outcome(staffApi.orgSettings.billing()),
      builderChanges: await outcome(
        builder.api.orgSettings.updatePulse(officeHours)
      ),
      staffChanges: await outcome(
        staffApi.orgSettings.updateBilling({ ...billing, company: "Grasp" })
      ),
      kept: await admin.api.orgSettings.billing(),
    }).toStrictEqual({
      builder: "role.forbidden",
      member: "role.forbidden",
      staffReads: "role.forbidden",
      builderChanges: "role.forbidden",
      staffChanges: "role.forbidden",
      kept: {
        ...billing,
        company: "Acme Holding B.V.",
        vatNumber: "NL123456789B01",
      },
    });
  });

  it("refuse what isn't a billing detail or a Pulse setting, and keep what was saved", async () => {
    const admin = await signedInApi(idp, "admin");
    const api = admin.api.orgSettings;
    await api.updatePulse(officeHours);
    const day = Array.from({ length: 24 }, () => true);
    const sent = await Promise.all([
      outcome(api.updateBilling({ ...billing, email: "not an email" })),
      outcome(api.updateBilling({ ...billing, company: "Two\nlines" })),
      outcome(api.updateBilling({ ...billing, vatNumber: "123" })),
      outcome(api.updatePulse({ ...officeHours, schedule: [day] })),
      outcome(
        api.updatePulse({
          ...officeHours,
          schedule: officeHours.schedule.map((hours) => hours.slice(1)),
        })
      ),
      outcome(
        api.updatePulse({
          ...officeHours,
          employeeDomains: ["acme.test", "acme.test"],
        })
      ),
      outcome(
        api.updatePulse({ ...officeHours, employeeDomains: ["Not a domain"] })
      ),
    ]);
    expect({ sent, kept: await api.pulse() }).toStrictEqual({
      sent: [
        "org_settings.billing_invalid",
        "org_settings.billing_invalid",
        "org_settings.billing_invalid",
        "org_settings.pulse_invalid",
        "org_settings.pulse_invalid",
        "org_settings.pulse_invalid",
        "org_settings.pulse_invalid",
      ],
      kept: officeHours,
    });
  });

  it("record each change with who made it and what changed, never the values", async () => {
    const admin = await signedInApi(idp, "admin");
    const events = await auditedDuring(async () => {
      await admin.api.orgSettings.updateBilling(billing);
      // Nothing changes, so nothing is recorded.
      await admin.api.orgSettings.updateBilling(billing);
      await admin.api.orgSettings.updateBilling({
        ...billing,
        emailReceipts: true,
      });
      await admin.api.orgSettings.updatePulse(officeHours);
    });

    expect(events).toStrictEqual([
      expect.objectContaining({
        action: "org_settings.billing.updated",
        actor: { type: "person", userId: admin.userId },
        target: { type: "organization", id: "organization" },
        detail: { fields: "address,company,email,emailInvoices,vatNumber" },
      }),
      expect.objectContaining({
        action: "org_settings.billing.updated",
        detail: { fields: "emailReceipts" },
      }),
      expect.objectContaining({
        action: "org_settings.pulse.updated",
        detail: { fields: "employeeDomains,schedule" },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(sentinel);
    expect(JSON.stringify(events)).not.toContain("Keizersgracht");
  });

  it("say how people sign in, as the deployment sets it up, to admins alone, and never a secret", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");

    const signIn = await admin.api.orgSettings.signIn();
    expect({
      signIn,
      builder: await outcome(builder.api.orgSettings.signIn()),
    }).toStrictEqual({
      signIn: {
        configured: true,
        domains: signInConfig.domains,
        providers: [
          {
            provider: "microsoft",
            tenantId: signInConfig.entra.tenantId,
            clientId: entraClient.id,
            secretSet: true,
            offered: true,
          },
          {
            provider: "google",
            hostedDomain: signInConfig.google.hostedDomain,
            clientId: googleClient.id,
            secretSet: true,
            offered: true,
          },
        ],
        // Its end is the deployment's, set when the test's config was made.
        staffWindow: { open: true, until: signIn.staffWindow?.until },
      },
      builder: "role.forbidden",
    });
    expect(Date.parse(signIn.staffWindow?.until ?? "")).toBeGreaterThan(
      Date.now()
    );
    expect(JSON.stringify(signIn)).not.toContain(entraClient.secret);
    expect(JSON.stringify(signIn)).not.toContain(googleClient.secret);
  });
});
