import type {
  ListedConnection,
  OfferedCatalog,
} from "@grasp-os/shared/connect";
import { describe, expect, it } from "vite-plus/test";

import {
  categoriesOf,
  integrationsOf,
  keeps,
  matches,
  parseIntegrationKey,
  stateOf,
} from "./integrations.ts";

// The Integrations page's one list: what is connected must never drop out
// of it, whatever the catalog lists, and what needs signing in again must
// show as that, whatever else is connected.

type Entry = OfferedCatalog["entries"][number];

const entry = (
  id: string,
  categories: string[],
  source: Entry["source"] = "native"
): Entry => ({
  source,
  id,
  name: id.toUpperCase(),
  categories,
  toolCount: 3,
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

describe("filters and search", () => {
  const [microsoft, google] = integrationsOf(
    [entry("microsoft", ["Email", "Files"]), entry("google", ["Email"])],
    [connection("microsoft", "personal", "needs_reauth")]
  );

  it("keeps what each filter names", () => {
    const kept = (filter: Parameters<typeof keeps>[0]) =>
      [microsoft, google]
        .filter((integration) => integration !== undefined)
        .filter((integration) => keeps(filter, integration))
        .map(({ id }) => id);
    expect(kept({ show: "all" })).toStrictEqual(["microsoft", "google"]);
    expect(kept({ show: "connected" })).toStrictEqual(["microsoft"]);
    expect(kept({ show: "attention" })).toStrictEqual(["microsoft"]);
    expect(kept({ show: "category", category: "Files" })).toStrictEqual([
      "microsoft",
    ]);
  });

  it("searches by name or kind, whatever the case", () => {
    expect(microsoft !== undefined && matches(microsoft, "files")).toBeTruthy();
    expect(google !== undefined && matches(google, "GOO")).toBeTruthy();
    expect(google !== undefined && matches(google, "files")).toBeFalsy();
  });

  it("counts each category once per integration, by name", () => {
    expect(
      categoriesOf(
        [microsoft, google].filter((integration) => integration !== undefined),
        "en"
      )
    ).toStrictEqual([
      { category: "Email", count: 2 },
      { category: "Files", count: 1 },
    ]);
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
