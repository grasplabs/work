import type {
  ListedConnection,
  OfferedCatalog,
} from "@grasp-os/shared/connect";
import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { ConnectionWorkflow } from "@grasp-os/shared/workflows";
import { describe, expect, it } from "vite-plus/test";

import {
  beyond,
  find,
  integrationsOf,
  keeps,
  nearestApps,
  parseIntegrationKey,
  roundedDown,
  sectionsOf,
  stateOf,
  workflowsOf,
} from "./integrations.ts";

// The Integrations page's one list: what is connected must never drop out
// of it, whatever the catalog lists, and what needs signing in again must
// show as that, whatever else is connected.

type Entry = OfferedCatalog["entries"][number];

const entry = (
  id: string,
  categories: string[],
  {
    source = "native",
    group = "Other",
    description = null,
    name = id.toUpperCase(),
    offered = true,
  }: Partial<
    Pick<Entry, "source" | "group" | "description" | "name" | "offered">
  > = {}
): Entry => ({
  source,
  id,
  name,
  categories,
  toolCount: 3,
  logo: null,
  description,
  group,
  auth: "managed",
  offered,
});

const connection = (
  provider: string,
  scope: ListedConnection["scope"],
  status: ListedConnection["status"],
  createdAt = "2026-10-01T00:00:00.000Z"
): ListedConnection => ({
  id: crypto.randomUUID(),
  source: "native",
  provider,
  scope,
  status,
  ownerUserId: scope === "personal" ? "me" : null,
  connectedBy: "me",
  connectedByName: "Me",
  accountName: null,
  createdAt,
});

describe(integrationsOf, () => {
  it("lists the catalog in its order, each with its connections, newest first", () => {
    const older = connection("microsoft", "personal", "active");
    const newer = connection(
      "microsoft",
      "shared",
      "active",
      "2026-10-02T00:00:00.000Z"
    );
    const listed = integrationsOf(
      [entry("microsoft", ["Email"]), entry("google", ["Email"])],
      [older, newer]
    );
    expect(listed.map(({ key }) => key)).toStrictEqual([
      "native:microsoft",
      "native:google",
    ]);
    expect(listed[0]?.connections).toStrictEqual([newer, older]);
    expect(listed[1]?.connections).toStrictEqual([]);
  });

  it("keeps a connection whose entry the catalog doesn't list, under its provider's ID", () => {
    const listed = integrationsOf(
      [],
      [connection("hubspot", "shared", "active")]
    );
    expect(listed).toMatchObject([
      { key: "native:hubspot", name: "hubspot", listed: false, offered: false },
    ]);
  });

  it("leaves out disconnected connections", () => {
    const [microsoft] = integrationsOf(
      [entry("microsoft", [])],
      [connection("microsoft", "personal", "disconnected")]
    );
    expect(microsoft === undefined ? undefined : stateOf(microsoft)).toBe(
      "not_connected"
    );
  });
});

describe(stateOf, () => {
  const stateWith = (...connections: ListedConnection[]) => {
    const [integration] = integrationsOf([entry("microsoft", [])], connections);
    return integration === undefined ? undefined : stateOf(integration);
  };

  it("says it needs signing in again before anything else", () => {
    expect(
      stateWith(
        connection("microsoft", "shared", "active"),
        connection("microsoft", "personal", "needs_reauth")
      )
    ).toBe("needs_reauth");
  });

  it("says shared before personal", () => {
    expect(
      stateWith(
        connection("microsoft", "personal", "active"),
        connection("microsoft", "shared", "active")
      )
    ).toBe("shared");
    expect(stateWith(connection("microsoft", "personal", "active"))).toBe(
      "personal"
    );
  });
});

describe("filters, search and sections", () => {
  const [microsoft, google, hubspot] = integrationsOf(
    [
      entry("microsoft", ["Email"], { group: "Email and calendar" }),
      entry("google", ["Email"], {
        group: "Email and calendar",
        description: "Mail and files from Google.",
      }),
      entry("hubspot", ["CRM"], { group: "CRM" }),
    ],
    [connection("google", "personal", "needs_reauth")]
  );
  const all = [microsoft, google, hubspot].filter(
    (integration) => integration !== undefined
  );

  it("keeps what each filter names: everything, what is connected, or one kind", () => {
    const kept = (filter: Parameters<typeof keeps>[0]) =>
      all
        .filter((integration) => keeps(filter, integration))
        .map(({ id }) => id);
    expect(kept({ show: "all" })).toStrictEqual([
      "microsoft",
      "google",
      "hubspot",
    ]);
    expect(kept({ show: "connected" })).toStrictEqual(["google"]);
    expect(kept({ show: "group", group: "CRM" })).toStrictEqual(["hubspot"]);
  });

  it("finds by name before what an app is for, whatever the case", () => {
    expect(find(all, "GOO").map(({ id }) => id)).toStrictEqual(["google"]);
    expect(find(all, "files").map(({ id }) => id)).toStrictEqual(["google"]);
    // Google by its name, Microsoft only by its kind (Email).
    expect(find(all, "e").map(({ id }) => id)).toStrictEqual([
      "google",
      "microsoft",
    ]);
  });

  it("puts the apps most companies look for first when nothing is typed", () => {
    const [linear, zapier] = integrationsOf(
      [entry("zapier", []), entry("linear", [])],
      []
    ).toReversed();
    expect(
      find(
        [zapier, linear].filter((integration) => integration !== undefined)
      ).map(({ id }) => id)
    ).toStrictEqual(["linear", "zapier"]);
  });

  it("rounds a count down to say more than it", () => {
    expect(roundedDown(1487)).toBe(1400);
    expect(roundedDown(187)).toBe(150);
    expect(roundedDown(47)).toBe(40);
  });
});

describe(parseIntegrationKey, () => {
  it("reads a source and an ID, and nothing else", () => {
    expect(parseIntegrationKey("composio:hubspot")).toStrictEqual({
      source: "composio",
      id: "hubspot",
    });
    expect(parseIntegrationKey("hubspot")).toBeUndefined();
    expect(parseIntegrationKey("other:hubspot")).toBeUndefined();
    expect(parseIntegrationKey("native:a:b")).toBeUndefined();
  });
});

describe("beyond and nearestApps", () => {
  const listed = integrationsOf(
    [
      entry("microsoft", [], { name: "Microsoft 365" }),
      entry("microsoft_365", [], { source: "composio", name: "Microsoft 365" }),
      entry("hubspot", [], { source: "composio", name: "HubSpot" }),
      entry("hubspot_ads", [], { source: "composio", name: "HubSpot Ads" }),
      entry("google_sheets", [], { source: "composio", name: "Google Sheets" }),
    ],
    [connection("microsoft", "shared", "active")]
  );

  it("leaves out what the company is connected to, even under another entry", () => {
    expect(beyond(listed).map(({ id }) => id)).toStrictEqual([
      "hubspot",
      "hubspot_ads",
      "google_sheets",
    ]);
  });

  it("finds the nearest apps by name, the shortest first, however it is typed", () => {
    expect(
      nearestApps(beyond(listed), "hub spot").map(({ id }) => id)
    ).toStrictEqual(["hubspot", "hubspot_ads"]);
    expect(nearestApps(beyond(listed), "google_sheets")).toHaveLength(1);
  });

  it("finds an app whose name the typed one holds, but not a short fragment", () => {
    expect(
      nearestApps(beyond(listed), "Google Sheets for finance")
    ).toHaveLength(1);
    expect(nearestApps(beyond(listed), "hu")).toStrictEqual([]);
  });

  it("leaves out an app that isn't offered", () => {
    const unoffered = integrationsOf(
      [
        entry("hubspot", [], {
          source: "composio",
          name: "HubSpot",
          offered: false,
        }),
      ],
      []
    );
    expect(beyond(unoffered)).toStrictEqual([]);
  });

  it("keeps the app named exactly, however many shorter names it holds", () => {
    const many = integrationsOf(
      ["Sales", "Force", "Sale", "Salesforce"].map((name) =>
        entry(name.toLowerCase(), [], { source: "composio", name })
      ),
      []
    );
    expect(
      nearestApps(many, "salesforce", 1).map(({ name }) => name)
    ).toStrictEqual(["Salesforce"]);
  });

  it("offers at most the number asked for", () => {
    expect(nearestApps(beyond(listed), "hubspot", 1)).toHaveLength(1);
  });
});

const appWorkflow = (
  appName: string,
  workflow: string
): ConnectionWorkflow => ({
  kind: "app",
  app: appIdSchema.parse(`app-${appName}`),
  appName,
  workflow: workflowIdSchema.parse(workflow),
});

const independent = (name: string): ConnectionWorkflow => ({
  kind: "independent",
  id: `workflow-${name}`,
  name,
});

/** Each section's apps, by ID. */
const ids = (sections: ReturnType<typeof sectionsOf>) => ({
  lapsed: sections.lapsed.map(({ id }) => id),
  connected: sections.connected.map(({ id }) => id),
  unused: sections.unused.map(({ id }) => id),
  others: sections.others.map(({ id }) => id),
});

describe(sectionsOf, () => {
  const used = connection("microsoft", "shared", "active");
  const idle = connection("slack", "personal", "active");
  const lapsed = connection("google", "shared", "needs_reauth");
  const all = integrationsOf(
    [
      entry("microsoft", ["Email"], { group: "Email and calendar" }),
      entry("slack", ["Chat"], { group: "Chat" }),
      entry("google", ["Email"], { group: "Email and calendar" }),
      entry("hubspot", ["CRM"], { group: "CRM" }),
    ],
    [used, idle, lapsed]
  );
  const uses = [
    { connectionId: used.id, workflows: [independent("Digest")] },
    { connectionId: lapsed.id, workflows: [independent("Calendar")] },
  ];

  it("puts each app under where it stands: its relied-on connection lapsed, used, unused, or not connected", () => {
    expect(
      ids(sectionsOf(all, { show: "all" }, undefined, uses))
    ).toStrictEqual({
      lapsed: ["google"],
      connected: ["microsoft"],
      unused: ["slack"],
      others: ["hubspot"],
    });
  });

  it("calls nothing unused until it is known which workflows use what", () => {
    expect(ids(sectionsOf(all, { show: "all" }))).toStrictEqual({
      lapsed: ["google"],
      connected: ["microsoft", "slack"],
      unused: [],
      others: ["hubspot"],
    });
  });

  it("keeps only what the filter and the search leave", () => {
    expect(
      ids(sectionsOf(all, { show: "connected" }, undefined, uses))
    ).toStrictEqual({
      lapsed: ["google"],
      connected: ["microsoft"],
      unused: ["slack"],
      others: [],
    });
    expect(
      ids(
        sectionsOf(
          all,
          { show: "group", group: "Email and calendar" },
          "goo",
          uses
        )
      )
    ).toStrictEqual({
      lapsed: ["google"],
      connected: [],
      unused: [],
      others: [],
    });
  });

  it("calls an app lapsed only when the connection relied on did, not a spare beside one that works", () => {
    const working = connection("notion", "shared", "active");
    const spare = connection("notion", "shared", "needs_reauth");
    const ownOnly = connection("zoom", "personal", "needs_reauth");
    const usedSpare = connection("jira", "personal", "needs_reauth");
    const jiraShared = connection("jira", "shared", "active");
    const apps = integrationsOf(
      [entry("notion", []), entry("zoom", []), entry("jira", [])],
      [working, spare, ownOnly, usedSpare, jiraShared]
    );
    const workflows = [
      { connectionId: usedSpare.id, workflows: [independent("Sync")] },
      { connectionId: working.id, workflows: [independent("Notes")] },
    ];
    expect(
      ids(sectionsOf(apps, { show: "all" }, undefined, workflows))
    ).toStrictEqual({
      lapsed: ["zoom", "jira"],
      connected: ["notion"],
      unused: [],
      others: [],
    });
  });
});

describe(workflowsOf, () => {
  it("lists each workflow that uses any of an app's connections once, App workflows first, by App and name", () => {
    const shared = connection("microsoft", "shared", "active");
    const personal = connection("microsoft", "personal", "active");
    const elsewhere = connection("google", "shared", "active");
    const [microsoft] = integrationsOf(
      [entry("microsoft", [])],
      [shared, personal, elsewhere]
    );
    const uses = [
      {
        connectionId: shared.id,
        workflows: [appWorkflow("Payroll", "remind"), independent("Digest")],
      },
      {
        connectionId: personal.id,
        workflows: [
          appWorkflow("Invoices", "send"),
          appWorkflow("Payroll", "remind"),
        ],
      },
      { connectionId: elsewhere.id, workflows: [independent("Calendar")] },
    ];
    expect(
      microsoft === undefined ? undefined : workflowsOf(microsoft, uses)
    ).toStrictEqual([
      appWorkflow("Invoices", "send"),
      appWorkflow("Payroll", "remind"),
      independent("Digest"),
    ]);
  });
});
