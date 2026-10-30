import { describe, expect, it } from "vite-plus/test";

import { domainOfEmail, slugOf } from "../src/admin/new-organization.ts";
import { stageKind } from "../src/crm/attio.ts";
import { signInProvidersOf } from "../src/hosting/progress.ts";

describe("a new organization's web address", () => {
  it("is made from its name: accents dropped, lowercase, dashes between words, none at the ends", () => {
    expect(
      [
        "Bakkerij Dé Graaf & Müller B.V.",
        "  Acme  ",
        "ACME—Holdings (EU)",
        "x".repeat(80),
      ].map(slugOf)
    ).toStrictEqual([
      "bakkerij-de-graaf-muller-b-v",
      "acme",
      "acme-holdings-eu",
      "x".repeat(50),
    ]);
  });

  it("takes its first admin's domain from their email", () => {
    expect(
      ["ada@Acme.COM", "nobody", "@acme.de"].map(domainOfEmail)
    ).toStrictEqual(["acme.com", "", "acme.de"]);
  });
});

/** A sign-in config naming `providers`, as its record keeps it. */
const signIn = (providers: object): string =>
  JSON.stringify({
    domains: ["acme.test"],
    admins: ["ada@acme.test"],
    ...providers,
  });

describe("the sign-in step of an organization's progress", () => {
  it("names the providers its sign-in names, or none", () => {
    expect(
      [
        signIn({ googleHostedDomain: "acme.test" }),
        signIn({ entraTenantId: "4a1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" }),
        signIn({
          googleHostedDomain: "acme.test",
          entraTenantId: "4a1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        }),
        null,
      ].map(signInProvidersOf)
    ).toStrictEqual([
      "Google Workspace",
      "Microsoft 365",
      "Google Workspace and Microsoft 365",
      null,
    ]);
  });
});

describe("a deal's stage in Attio, as the prototype's CRM has it", () => {
  it("is read by its title's words, and a lost deal or another title has none", () => {
    expect(
      [
        "Lead",
        "Qualified",
        "In Progress",
        "Proposal sent",
        "Negotiation",
        "Won 🎉",
        "Closed won",
        "Lost",
        "Closed lost",
        "On hold",
      ].map(stageKind)
    ).toStrictEqual([
      "lead",
      "lead",
      "proposal",
      "proposal",
      "proposal",
      "won",
      "won",
      null,
      null,
      null,
    ]);
  });
});
