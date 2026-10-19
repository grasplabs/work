import type { ListedConnection } from "@grasp-os/shared/connect";
import {
  appIdSchema,
  connectionIdSchema,
  permissionIdSchema,
} from "@grasp-os/shared/ids";
import type { Permission } from "@grasp-os/shared/permissions";
import { describe, expect, it } from "vite-plus/test";

import { integrationsOf } from "../connections/integrations.ts";
import { tabOf } from "./landscape-app.ts";
import { landscapeAppsOf } from "./landscape-data.ts";
import {
  defaultColumns,
  landscapeCsv,
  matchesLandscape,
  moveColumn,
  mosaicGroups,
  nextSort,
  noFilters,
  sortApps,
  sortedExposure,
} from "./landscape.ts";
import type { LandscapeApp, LandscapeFilters } from "./landscape.ts";
import { squarify } from "./treemap.ts";

// The Landscape's own logic, as the prototype tests it (lib/landscape.test.ts),
// over apps made for the test, and how its apps come from the integrations.

const app = (patch: Partial<LandscapeApp> & { id: string }): LandscapeApp => ({
  name: patch.id,
  vendor: null,
  category: null,
  description: null,
  aiType: "Unknown",
  dataExposure: null,
  dataExposureReason: "",
  hosting: [],
  users: null,
  owner: null,
  firstSeen: "2026-09-01T10:00:00.000Z",
  connectionIds: [],
  use: { sources: ["native"], engines: [] },
  blocked: false,
  flagged: false,
  policySource: null,
  ...patch,
});

const chatGpt = app({
  id: "chatgpt",
  name: "ChatGPT",
  vendor: "OpenAI",
  category: "AI assistants",
  aiType: "Core",
  dataExposure: ["customer", "code"],
  users: 46,
  owner: "Eva Bakker",
  use: { sources: ["composio"], engines: [{ id: "e1", name: "Invoices" }] },
});
const notion = app({
  id: "notion",
  name: "Notion",
  vendor: "Notion Labs",
  category: "Productivity",
  aiType: "Embed",
  dataExposure: ["employee"],
  users: 120,
});
const lenders = app({
  id: "lenders",
  name: "Lender portals",
  category: "Productivity",
});
const all = [chatGpt, notion, lenders];

const matching = (filters: Partial<LandscapeFilters>, query = "") =>
  all
    .filter((each) =>
      matchesLandscape(each, { ...noFilters, ...filters }, query)
    )
    .map(({ name }) => name);

describe("matching the landscape's filters", () => {
  it("shows every app without filters", () => {
    expect(matching({})).toHaveLength(all.length);
  });

  it("matches any choice within a facet", () => {
    expect(matching({ aiType: ["Core", "Embed"] })).toStrictEqual([
      "ChatGPT",
      "Notion",
    ]);
    // Nothing measures how many use Lender portals: it is in no bucket.
    expect(matching({ users: ["lt10", "gte100"] })).toStrictEqual(["Notion"]);
    expect(
      matchesLandscape(
        { ...lenders, users: 4 },
        { ...noFilters, users: ["lt10"] },
        ""
      )
    ).toBeTruthy();
  });

  it("puts each count in exactly one bucket", () => {
    const bucketsOf = (users: number) =>
      (["lt10", "10to50", "50to100", "gte100"] as const).filter((bucket) =>
        matchesLandscape(
          { ...lenders, users },
          { ...noFilters, users: [bucket] },
          ""
        )
      );
    expect([9, 10, 49, 50, 99, 100].map(bucketsOf)).toStrictEqual([
      ["lt10"],
      ["10to50"],
      ["10to50"],
      ["50to100"],
      ["50to100"],
      ["gte100"],
    ]);
  });

  it("needs every quick filter to hold", () => {
    expect(matching({ show: ["unowned"] })).toStrictEqual([
      "Notion",
      "Lender portals",
    ]);
    expect(matching({ show: ["unowned", "unused"] })).toStrictEqual([
      "Notion",
      "Lender portals",
    ]);
    expect(matching({ show: ["core", "unowned"] })).toStrictEqual([]);
  });

  it("counts an app as not in an engine only when its engines were read", () => {
    const unread = { ...lenders, use: { sources: [], engines: null } };
    expect(
      [lenders, unread].map((each) =>
        matchesLandscape(each, { ...noFilters, show: ["unused"] }, "")
      )
    ).toStrictEqual([true, false]);
  });

  it('treats an app without an owner as "unowned"', () => {
    expect(matching({ owner: ["unowned"] })).toStrictEqual([
      "Notion",
      "Lender portals",
    ]);
  });

  it("never matches data an app's exposure isn't known for", () => {
    expect(matching({ dataExposure: ["customer", "employee"] })).toStrictEqual([
      "ChatGPT",
      "Notion",
    ]);
  });

  it("searches name, vendor and category, ignoring case", () => {
    expect(matching({}, "chatgpt")).toStrictEqual(["ChatGPT"]);
    expect(matching({}, "OPENAI")).toStrictEqual(["ChatGPT"]);
    expect(matching({}, " productivity ")).toStrictEqual([
      "Notion",
      "Lender portals",
    ]);
  });
});

describe("sorting", () => {
  it("cycles ascending, descending, then off", () => {
    const asc = nextSort(null, "users");
    const desc = nextSort(asc, "users");
    expect([asc, desc, nextSort(desc, "users")]).toStrictEqual([
      { key: "users", dir: "asc" },
      { key: "users", dir: "desc" },
      null,
    ]);
    expect(nextSort(desc, "name")).toStrictEqual({ key: "name", dir: "asc" });
  });

  it("sorts by users without changing the list it was given, unknown counts last", () => {
    const sorted = sortApps(all, { key: "users", dir: "desc" });
    expect(sorted.map(({ id }) => id)).toStrictEqual([
      "notion",
      "chatgpt",
      "lenders",
    ]);
    expect(
      sortApps(all, { key: "users", dir: "asc" }).map(({ id }) => id)
    ).toStrictEqual(["chatgpt", "notion", "lenders"]);
    expect(all.map(({ id }) => id)).toStrictEqual([
      "chatgpt",
      "notion",
      "lenders",
    ]);
  });

  it("puts apps without an owner last when sorting by owner", () => {
    const sorted = sortApps(all, { key: "owner", dir: "asc" });
    expect([sorted[0]?.owner, sorted.at(-1)?.owner]).toStrictEqual([
      "Eva Bakker",
      null,
    ]);
  });
});

describe("columns", () => {
  it("moves one column and keeps the rest in order", () => {
    const moved = moveColumn(defaultColumns, 5, 0).map(({ key }) => key);
    expect(moved).toStrictEqual([
      "owner",
      "aiType",
      "source",
      "processes",
      "dataExposure",
      "users",
    ]);
  });
});

describe("exports", () => {
  it("quotes values with commas and quotes", () => {
    const quoted = { ...chatGpt, description: 'Writes, "drafts" and more' };
    expect(landscapeCsv([quoted]).split("\n")[1]).toContain(
      '"Writes, ""drafts"" and more"'
    );
  });

  it("keeps a cell that starts like a formula from running as one", () => {
    const formula = {
      ...chatGpt,
      name: '=HYPERLINK("x")',
      description: "@SUM(A1)",
    };
    const [, row = ""] = landscapeCsv([formula]).split("\n");
    expect([row.split(",")[0], row.split(",").at(-1)]).toStrictEqual([
      `"'=HYPERLINK(""x"")"`,
      "'@SUM(A1)",
    ]);
  });

  it("leaves data and usage it doesn't know empty, and says None for an app that touches none", () => {
    const [, unknown] = landscapeCsv([lenders]).split("\n");
    const [, none] = landscapeCsv([
      { ...lenders, dataExposure: [], users: 0 },
    ]).split("\n");
    expect([unknown, none]).toStrictEqual([
      "Lender portals,,Productivity,Unknown,,,,",
      "Lender portals,,Productivity,Unknown,None,0,,",
    ]);
  });
});

describe("data exposure", () => {
  it("leads with the most sensitive kind", () => {
    expect(sortedExposure(["code", "employee", "customer"])).toStrictEqual([
      "customer",
      "employee",
      "code",
    ]);
  });
});

describe("mosaic", () => {
  it("groups every app once, the most used category first", () => {
    const groups = mosaicGroups(all);
    expect(groups.flatMap((group) => group.apps)).toHaveLength(all.length);
    expect(groups.map(({ category }) => category)).toStrictEqual([
      "Productivity",
      "AI assistants",
    ]);
    // An app whose usage nothing measures still gets some room.
    expect(
      groups[0]?.apps.find((each) => each.app.id === "lenders")?.weight
    ).toBe(3);
  });

  it("knows a category's users only when something measures them", () => {
    expect(
      mosaicGroups(all).map(({ category, users }) => ({ category, users }))
    ).toStrictEqual([
      { category: "Productivity", users: 120 },
      { category: "AI assistants", users: 46 },
    ]);
    expect(mosaicGroups([lenders]).map(({ users }) => users)).toStrictEqual([
      null,
    ]);
  });

  it("fills the frame with rectangles in proportion to their values", () => {
    const rects = squarify([6, 3, 1], { x: 0, y: 0, width: 100, height: 100 });
    const areas = rects.map((rect) => rect.width * rect.height);
    expect(areas.reduce((sum, area) => sum + area, 0)).toBeCloseTo(10_000);
    expect((areas[0] ?? 0) / (areas[2] ?? 1)).toBeCloseTo(6);
  });
});

describe("an app's tabs", () => {
  it("reads the tab from the address, its ID encoded or not, the Overview by default", () => {
    expect([
      tabOf("/landscape/native%3Amicrosoft/usage/u1", "native:microsoft"),
      tabOf("/landscape/native:microsoft/audit", "native:microsoft"),
      tabOf("/landscape/native:microsoft", "native:microsoft"),
      tabOf("/landscape/native:microsoft/nothing", "native:microsoft"),
    ]).toStrictEqual(["usage", "audit", "overview", "overview"]);
  });
});

const connection = (
  patch: Partial<ListedConnection> & { id: string }
): ListedConnection => ({
  source: "native",
  provider: "microsoft",
  scope: "personal",
  status: "active",
  ownerUserId: "u1",
  connectedBy: "u1",
  connectedByName: "Eva Bakker",
  accountName: "eva@acme.test",
  createdAt: "2026-09-10T10:00:00.000Z",
  ...patch,
});

const permission = (
  appId: string,
  connectionId: string,
  status: Permission["status"]
): Permission => ({
  id: permissionIdSchema.parse(`${appId}-${connectionId}`),
  subject: { type: "app", appId: appIdSchema.parse(appId) },
  object: {
    type: "connection",
    connectionId: connectionIdSchema.parse(connectionId),
  },
  actions: ["read"],
  binding: "mail",
  status,
  requestedBy: "u1",
  requestedAt: "2026-09-10T10:00:00.000Z",
  grantedBy: "u1",
  grantedAt: "2026-09-10T10:00:00.000Z",
  revokedBy: null,
  revokedAt: null,
  requestedVia: null,
  chat: null,
});

const entries = [
  {
    source: "native" as const,
    id: "microsoft",
    name: "Microsoft 365",
    categories: ["Productivity"],
    toolCount: 12,
    logo: null,
    description: null,
    group: "Email and calendar" as const,
    // Every native provider's sign-in app is Grasp's.
    auth: "managed" as const,
    offered: true,
  },
  {
    source: "native" as const,
    id: "google",
    name: "Google Workspace",
    categories: ["Productivity"],
    toolCount: 9,
    logo: null,
    description: null,
    group: "Email and calendar" as const,
    // Every native provider's sign-in app is Grasp's.
    auth: "managed" as const,
    offered: true,
  },
];

describe("the landscape's apps", () => {
  it("are the integrations someone connected, first seen with their first connection", () => {
    const apps = landscapeAppsOf(
      integrationsOf(entries, [
        connection({ id: "c2", createdAt: "2026-09-12T10:00:00.000Z" }),
        connection({ id: "c1", createdAt: "2026-09-02T10:00:00.000Z" }),
        connection({
          id: "c3",
          source: "composio",
          provider: "hubspot",
          scope: "shared",
          ownerUserId: null,
        }),
        connection({ id: "gone", provider: "google", status: "disconnected" }),
      ])
    );
    expect(
      apps.map(({ id, name, category, firstSeen, connectionIds, use }) => ({
        id,
        name,
        category,
        firstSeen,
        connectionIds,
        sources: use.sources,
      }))
    ).toStrictEqual([
      {
        id: "native:microsoft",
        name: "Microsoft 365",
        category: "Productivity",
        firstSeen: "2026-09-02T10:00:00.000Z",
        connectionIds: ["c2", "c1"],
        sources: ["native"],
      },
      // The catalog doesn't list it: it goes by its provider's ID.
      {
        id: "composio:hubspot",
        name: "hubspot",
        category: null,
        firstSeen: "2026-09-10T10:00:00.000Z",
        connectionIds: ["c3"],
        sources: ["composio"],
      },
    ]);
  });

  it("leave unknown what nothing in Grasp records: vendor, AI type, data, owner and usage", () => {
    const [only] = landscapeAppsOf(
      integrationsOf(entries, [connection({ id: "c1" })])
    );
    expect(only).toMatchObject({
      vendor: null,
      aiType: "Unknown",
      dataExposure: null,
      hosting: [],
      owner: null,
      users: null,
    });
  });

  it("are used in the engines holding an active permission on one of their connections", () => {
    const [only] = landscapeAppsOf(
      integrationsOf(entries, [
        connection({ id: "c1" }),
        connection({ id: "c2" }),
      ]),
      {
        permissions: [
          permission("e2", "c2", "active"),
          permission("e1", "c1", "active"),
          permission("e1", "c2", "active"),
          permission("e3", "c1", "revoked"),
          permission("e4", "elsewhere", "active"),
        ],
        appNames: new Map([["e1", "Invoices"]]),
      }
    );
    expect(only?.use.engines).toStrictEqual([
      { id: "e2", name: "e2" },
      { id: "e1", name: "Invoices" },
    ]);
  });

  it("know none of their engines when the permissions couldn't be read, and none when no engine holds one", () => {
    const integrations = integrationsOf(entries, [connection({ id: "c1" })]);
    expect(
      [
        landscapeAppsOf(integrations),
        landscapeAppsOf(integrations, { permissions: [], appNames: new Map() }),
      ].map(([only]) => only?.use.engines)
    ).toStrictEqual([null, []]);
  });
});
