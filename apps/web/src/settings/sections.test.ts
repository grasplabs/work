import { describe, expect, it } from "vite-plus/test";

import {
  groupedSectionsFor,
  hiddenAt,
  sectionAt,
  sectionsFor,
} from "./sections.ts";

// Who sees which Settings sections: the filter the in-page list and,
// later, the Sidebar both read.

const ids = (viewer: Parameters<typeof sectionsFor>[0]): string[] =>
  sectionsFor(viewer).map((section) => section.id);

/** Which of a few addresses `viewer` is kept from. */
const hidden = (viewer: Parameters<typeof hiddenAt>[1]) =>
  [
    "/settings/profile",
    "/settings/instructions",
    "/settings/workspace",
    "/settings/members",
    "/settings/brain",
    "/settings/audit/event-1",
    "/settings/billing",
    "/settings",
  ].filter((pathname) => hiddenAt(pathname, viewer));

describe("Settings sections", () => {
  it("shows someone who isn't an admin their own account alone", () => {
    expect(ids({ role: "user", staff: false })).toStrictEqual([
      "profile",
      "appearance",
      "instructions",
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
      teams: own.includes("teams"),
      webhooks: own.includes("webhooks"),
    }).toStrictEqual({ members: true, teams: true, webhooks: true });
  });

  it("keeps the company's members and outside callers from Grasp staff", () => {
    const staff = ids({ role: "admin", staff: true });
    expect({
      members: staff.includes("members"),
      teams: staff.includes("teams"),
      webhooks: staff.includes("webhooks"),
      instructions: staff.includes("instructions"),
      workspace: staff.includes("workspace"),
    }).toStrictEqual({
      members: false,
      teams: false,
      webhooks: false,
      instructions: false,
      workspace: true,
    });
  });

  it("keeps every section out of sight of whoever may not see it, by its address and what lies under it", () => {
    const member = { role: "user", staff: false } as const;
    const staff = { role: "admin", staff: true } as const;
    const admin = { role: "admin", staff: false } as const;
    expect({
      member: hidden(member),
      staff: hidden(staff),
      admin: hidden(admin),
    }).toStrictEqual({
      member: [
        "/settings/members",
        "/settings/brain",
        "/settings/audit/event-1",
        "/settings/billing",
      ],
      staff: ["/settings/instructions", "/settings/members"],
      admin: [],
    });
  });

  it("opens the Workspace to everyone, read-only, though only admins find it listed", () => {
    const member = { role: "user", staff: false } as const;
    expect({
      listed: ids(member).includes("workspace"),
      hidden: hiddenAt("/settings/workspace", member),
      open: sectionAt("/settings/workspace", member)?.id,
    }).toStrictEqual({ listed: false, hidden: false, open: "workspace" });
  });
});
