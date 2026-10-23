import { describe, expect, it } from "vite-plus/test";

import { domainsOrAdmins, prefillOf } from "../src/admin/new-organization.ts";
import { stageKind } from "../src/crm/attio.ts";

describe("a new organization's email domains", () => {
  it("are the ones given, when given", () => {
    expect(domainsOrAdmins("acme.test", "ada@acme.example")).toBe("acme.test");
  });

  it("are the admins' own, each once and in order, when left empty", () => {
    expect(
      domainsOrAdmins(
        " ",
        "ada@acme.test, Bob@Acme.TEST tom@birch.test not-an-email"
      )
    ).toBe("acme.test, birch.test");
  });
});

describe("a new organization started from a deal won in Attio", () => {
  it("takes the company's name, an address made from it, and its domains", () => {
    expect(
      prefillOf({
        dealId: "deal",
        title: "Bakkerij De Graaf: Team",
        stage: "Won 🎉",
        on: "2026-10-13",
        companyId: "company",
        name: "Bakkerij Dé Graaf & Müller B.V.",
        domains: ["bakkerijdegraaf.test", "degraaf.test"],
      })
    ).toStrictEqual({
      name: "Bakkerij Dé Graaf & Müller B.V.",
      clientId: "bakkerij-de-graaf-muller-b-v",
      domains: "bakkerijdegraaf.test, degraaf.test",
    });
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
