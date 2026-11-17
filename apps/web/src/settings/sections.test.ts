import { describe, expect, it } from "vite-plus/test";

import { groupedSectionsFor, sectionsFor } from "./sections.ts";

// Who sees which Settings sections: the filter the in-page list and,
// later, the Sidebar both read.

const ids = (viewer: Parameters<typeof sectionsFor>[0]): string[] =>
  sectionsFor(viewer).map((section) => section.id);

describe("Settings sections", () => {
  it("shows someone who isn't an admin their own account alone", () => {
    expect(ids({ role: "user", staff: false })).toStrictEqual([
      "profile",
      "appearance",
      "security",
    ]);
    expect(
      groupedSectionsFor({ role: "builder", staff: false }).map(
        ({ group }) => group.id
      )
    ).toStrictEqual(["account"]);
  });

  it("lists the person's own account first, its profile first in it", () => {
    const admin = { role: "admin", staff: false } as const;
    expect({
      groups: groupedSectionsFor(admin).map(({ group }) => group.id),
      first: sectionsFor(admin)[0]?.id,
    }).toStrictEqual({ groups: ["account", "workspace"], first: "profile" });
  });

  it("shows the organization's own admin the sections kept from Grasp staff", () => {
    const own = ids({ role: "admin", staff: false });
    expect({
      members: own.includes("members"),
      webhooks: own.includes("webhooks"),
      outcomes: own.includes("outcomes"),
    }).toStrictEqual({ members: true, webhooks: true, outcomes: true });
  });

  it("keeps the company's members and outside callers from Grasp staff", () => {
    const staff = ids({ role: "admin", staff: true });
    expect({
      members: staff.includes("members"),
      webhooks: staff.includes("webhooks"),
      outcomes: staff.includes("outcomes"),
      workspace: staff.includes("workspace"),
    }).toStrictEqual({
      members: false,
      webhooks: false,
      outcomes: false,
      workspace: true,
    });
  });
});
