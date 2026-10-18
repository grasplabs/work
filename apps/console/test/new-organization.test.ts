import { describe, expect, it } from "vite-plus/test";

import { domainsOrAdmins } from "../src/admin/new-organization.ts";

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
