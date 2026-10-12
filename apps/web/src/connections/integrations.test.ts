import type {
  ListedConnection,
  OfferedCatalog,
} from "@grasp-os/shared/connect";
import { describe, expect, it } from "vite-plus/test";

import {
  find,
  integrationsOf,
  keeps,
  parseIntegrationKey,
  roundedDown,
  sectionsOf,
  stateOf,
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
  }: Partial<Pick<Entry, "source" | "group" | "description" | "name">> = {}
): Entry => ({
  source,
  id,
  name,
  categories,
  toolCount: 3,
  logo: null,
  description,
  group,
  offered: true,
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

  it("makes a section per kind of app, in Grasp's order, connected apps first", () => {
    expect(
      sectionsOf(all, { show: "all" }).map(({ group, own, others }) => ({
        group,
        own: own.map(({ id }) => id),
        others: others.map(({ id }) => id),
      }))
    ).toStrictEqual([
      { group: "Email and calendar", own: ["google"], others: ["microsoft"] },
      { group: "CRM", own: [], others: ["hubspot"] },
    ]);
  });

  it("shows only what is connected under Connected", () => {
    expect(
      sectionsOf(all, { show: "connected" }).flatMap(({ own, others }) =>
        [...own, ...others].map(({ id }) => id)
      )
    ).toStrictEqual(["google"]);
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
