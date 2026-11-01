import { noBilling } from "@grasp-os/shared/org-settings";
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

// The organization's billing settings (src/org-settings.ts).
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

describe("the organization's settings", () => {
  afterEach(async () => {
    await env.DB.prepare("DELETE FROM org_settings").run();
  });

  it("read as unset until an admin saves them, then as saved", async () => {
    const admin = await signedInApi(idp, "admin");
    const unset = await admin.api.orgSettings.billing();

    await admin.api.orgSettings.updateBilling(billing);

    expect({
      unset,
      billing: await admin.api.orgSettings.billing(),
    }).toStrictEqual({
      unset: noBilling,
      billing: {
        ...billing,
        company: "Acme Holding B.V.",
        vatNumber: "NL123456789B01",
      },
    });
  });

  it("are read by admins alone, and changed by the organization's own admins alone", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const member = await signedInApi(idp, "user");
    await admin.api.orgSettings.updateBilling(billing);
    const staff = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(staff);
    using staffApi = core.authenticate();

    expect({
      builder: await outcome(builder.api.orgSettings.billing()),
      member: await outcome(member.api.orgSettings.billing()),
      staffReads: await outcome(staffApi.orgSettings.billing()),
      builderChanges: await outcome(
        builder.api.orgSettings.updateBilling(billing)
      ),
      staffChanges: await outcome(
        staffApi.orgSettings.updateBilling({ ...billing, company: "Grasp" })
      ),
      kept: await admin.api.orgSettings.billing(),
    }).toStrictEqual({
      builder: "role.forbidden",
      member: "role.forbidden",
      staffReads: "ok",
      builderChanges: "role.forbidden",
      staffChanges: "role.forbidden",
      kept: {
        ...billing,
        company: "Acme Holding B.V.",
        vatNumber: "NL123456789B01",
      },
    });
  });

  it("refuse what isn't a billing detail, and keep what was saved", async () => {
    const admin = await signedInApi(idp, "admin");
    const api = admin.api.orgSettings;
    await api.updateBilling(billing);
    const sent = await Promise.all([
      outcome(api.updateBilling({ ...billing, email: "not an email" })),
      outcome(api.updateBilling({ ...billing, company: "Two\nlines" })),
      outcome(api.updateBilling({ ...billing, vatNumber: "123" })),
    ]);
    expect({ sent, kept: await api.billing() }).toStrictEqual({
      sent: [
        "org_settings.billing_invalid",
        "org_settings.billing_invalid",
        "org_settings.billing_invalid",
      ],
      kept: {
        ...billing,
        company: "Acme Holding B.V.",
        vatNumber: "NL123456789B01",
      },
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
