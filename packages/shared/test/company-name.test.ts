import { describe, expect, it } from "vite-plus/test";

import {
  companyNameOf,
  nameOfDomain,
  newOrganizationName,
  placeholderOrganizationName,
} from "../src/organization.ts";

describe("a domain's name", () => {
  it.each([
    ["noordkade.nl", "Noordkade"],
    ["acme.test", "Acme"],
    ["acme.co.uk", "Acme"],
    ["mail.acme.com", "Acme"],
    ["van-dijk.nl", "Van Dijk"],
    ["Bakkerij.NL", "Bakkerij"],
  ])("names %s %s", (domain, name) => {
    expect(nameOfDomain(domain)).toBe(name);
  });

  it.each(["", "localhost", "-.nl", "a_b.nl"])("names %j nothing", (domain) => {
    expect(nameOfDomain(domain)).toBeNull();
  });
});

describe("the company's name", () => {
  it("keeps a name the company gave", () => {
    expect(companyNameOf(" Noordkade Finance ", ["noordkade.nl"])).toBe(
      "Noordkade Finance"
    );
  });

  it("never shows the placeholder: the domain names it instead", () => {
    expect(companyNameOf(placeholderOrganizationName, ["acme.test"])).toBe(
      "Acme"
    );
    expect(companyNameOf("", ["acme.test"])).toBe("Acme");
  });

  it("is none when nothing gives a name", () => {
    expect(companyNameOf(placeholderOrganizationName, [])).toBeNull();
  });
});

describe("a new organization's name", () => {
  it("is the domain's name, the placeholder only without one", () => {
    expect(newOrganizationName(["acme.test"])).toBe("Acme");
    expect(newOrganizationName([])).toBe(placeholderOrganizationName);
  });
});
