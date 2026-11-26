import type {
  ListedConnection,
  OfferedCatalog,
} from "@grasp-os/shared/connect";
import { internalErrors } from "@grasp-os/shared/errors";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { catalogWaitMs, readChatNames } from "./chat-details.ts";

// What a chat's sources are called: each connection by the name the
// Connectors page gives it, read from core's connection list and its
// catalog; a catalog core refuses, or is slow to send, names each by the
// list alone, and a list it refuses names none.

const connector = "mcp_779f118c28fe4d5abc44822751adce18";

const listed = (
  id: string,
  provider: string,
  more: Partial<ListedConnection> = {}
): ListedConnection => ({
  id,
  source: "native",
  provider,
  scope: "shared",
  status: "active",
  ownerUserId: null,
  connectedBy: "me",
  connectedByName: "Me",
  accountName: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...more,
});

const connections = [
  listed("outlook", "microsoft", { accountName: "sanne@acme.test" }),
  listed("tracker", connector, {
    source: "connector",
    connectorName: "Issue tracker",
  }),
];

const catalog: OfferedCatalog = {
  composio: "off",
  entries: [
    {
      source: "native",
      id: "microsoft",
      name: "Microsoft 365",
      categories: [],
      toolCount: 3,
      logo: null,
      description: null,
      group: "Other",
      auth: "managed",
      offered: true,
    },
  ],
};

const refused = async (): Promise<never> => {
  await Promise.resolve();
  throw internalErrors.create("internal.unexpected");
};

/** The chat's source names, against core's connections faked at the session. */
const namesFrom = async (session: {
  list: () => Promise<ListedConnection[]>;
  catalog: () => Promise<OfferedCatalog>;
}) => {
  const core = {
    withSession: async <T>(
      action: (at: { connections: typeof session }) => Promise<T>
    ): Promise<T> => await action({ connections: session }),
  };
  // SAFETY: a stand-in for the parts of core's API the read uses.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const read = await readChatNames(core as never, new AbortController().signal);
  return read.state === "ready"
    ? Object.fromEntries(
        [...read.data.sourceNames].map(([id, { name }]) => [id, name])
      )
    : read.state;
};

describe(readChatNames, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names each connection as the Connectors page does", async () => {
    await expect(
      namesFrom({
        list: async () => await Promise.resolve(connections),
        catalog: async () => await Promise.resolve(catalog),
      })
    ).resolves.toStrictEqual({
      outlook: "Microsoft 365 (sanne@acme.test)",
      tracker: "Issue tracker",
    });
  });

  it("names each by the list alone when core refuses its catalog", async () => {
    await expect(
      namesFrom({
        list: async () => await Promise.resolve(connections),
        catalog: refused,
      })
    ).resolves.toStrictEqual({
      outlook: "microsoft (sanne@acme.test)",
      tracker: "Issue tracker",
    });
  });

  it("names each by the list alone when core is slow to send its catalog, inside the read's own deadline", async () => {
    vi.useFakeTimers();
    const names = namesFrom({
      list: async () => await Promise.resolve(connections),
      // An uncached catalog, waiting on Composio for longer than the read may.
      catalog: async () => await Promise.withResolvers<never>().promise,
    });
    await vi.advanceTimersByTimeAsync(catalogWaitMs);

    await expect(names).resolves.toStrictEqual({
      outlook: "microsoft (sanne@acme.test)",
      tracker: "Issue tracker",
    });
  });

  it("names none when core refuses the list", async () => {
    await expect(
      namesFrom({
        list: refused,
        catalog: async () => await Promise.resolve(catalog),
      })
    ).resolves.toStrictEqual({});
  });
});
