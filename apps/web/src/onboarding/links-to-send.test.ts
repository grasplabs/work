import type { LinkToSend } from "@grasp-os/shared/onboarding";
import { describe, expect, it } from "vite-plus/test";

import { linksCsv, linksOf } from "./links-to-send.ts";

const link = (
  person: string,
  out: boolean,
  fresh: boolean,
  name = person
): LinkToSend => ({
  person,
  name,
  team: "Sales",
  email: "",
  path: out ? `/interview#secret-${person}` : null,
  fresh,
  failedMail: null,
});

describe("the links the admin takes", () => {
  it.each([
    {
      when: "some are new: only those",
      links: [
        link("a", true, false),
        link("b", true, true),
        link("c", false, false),
      ],
      list: ["b"],
    },
    {
      when: "none are new: every one out",
      links: [
        link("a", true, false),
        link("b", true, false),
        link("c", false, false),
      ],
      list: ["a", "b"],
    },
    { when: "none are out: none", links: [link("c", false, false)], list: [] },
  ])("as a list, when $when", ({ links, list }) => {
    expect(linksOf(links).list.map(({ person }) => person)).toStrictEqual(list);
  });

  it("go into a spreadsheet as text, never as a formula, and without links not out", () => {
    expect(
      linksCsv(
        [link("a", true, true, "=HYPERLINK(1)"), link("b", false, false)],
        "https://acme.test",
        ["Name", "Email", "Team", "Link"]
      )
    ).toBe(
      "Name,Email,Team,Link\n'=HYPERLINK(1),,Sales,https://acme.test/interview#secret-a"
    );
  });
});
