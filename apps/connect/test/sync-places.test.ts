import { syncErrors } from "@grasp-os/shared/sync";
import type { SyncPageRequest, SyncPlacesRequest } from "@grasp-os/shared/sync";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { connections } from "../src/db/schema.ts";
import {
  addConnection,
  connectAccount,
  ownAccount,
  someone,
} from "./connect.ts";
import { sampleHost } from "./fixtures/sample-connector.ts";
import { fakeInternet } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";

// A sync's own places (src/sync.ts, `listSyncPlaces`): a sync that lists
// places of the connection's own account itself (`folders` of
// `sample-sync`, test/fixtures), each read as a source of its own. The ways
// it can fail come first: a place that steps out of one path segment, or
// out of the account; `own` read through a sync of places, or a place
// through a sync of the whole account; a shared connection's places
// before any is picked; a list with one bad place passed on in part.

const providers = fakeProviders();

/**
 * What the sample provider answers, for each test to set: its folders, a
 * page of them a read, by where the last page ended.
 */
const provider: { folders: Record<string, unknown> } = {
  folders: { "": { folders: ["inbox", "archive"] } },
};

const internet = fakeInternet((_request, url) => {
  if (url.pathname === "/v1/me/folders") {
    return Response.json(
      provider.folders[url.searchParams.get("from") ?? ""] ?? {}
    );
  }
  return Response.json({ changes: [], next: "1", more: false });
});

/** What reached the sample provider. */
const sentToProvider = () =>
  internet.sent
    .filter(({ host }) => host === sampleHost)
    .map(({ path }) => path.split("?")[0]);

/** A person's own Microsoft account, connected to the sample sync. */
const ownConnection = async (): Promise<string> => {
  provider.folders = { "": { folders: ["inbox", "archive"] } };
  const person = someone();
  const id = await connectAccount(providers, person, ownAccount(person));
  await drizzle(env.DB)
    .update(connections)
    .set({ server: "sample-sync" })
    .where(eq(connections.id, id));
  return id;
};

/** The code a call was refused with, or "ok". */
const outcomeOf = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    await call();
    return "ok";
  } catch (error) {
    return syncErrors.codeOf(error) ?? String(error);
  }
};

const places = async (request: SyncPlacesRequest) =>
  await exports.default.listSyncPlaces(request);

const read = async (request: SyncPageRequest) =>
  await exports.default.readSyncPage(request);

describe("a sync's own places", () => {
  it("lists the places a sync reads, and the whole account for a sync of it", async () => {
    const connectionId = await ownConnection();
    await expect(
      places({ connectionId, feed: "folders", cursor: null })
    ).resolves.toStrictEqual({ places: ["inbox", "archive"], cursor: null });
    // A sync of the whole account is one source: the account.
    await expect(
      places({ connectionId, feed: "files", cursor: null })
    ).resolves.toStrictEqual({ places: ["own"], cursor: null });
    expect(sentToProvider()).toStrictEqual(["/v1/me/folders"]);
  });

  it("reads a listed place from its own feed, and nothing outside one place", async () => {
    const connectionId = await ownConnection();
    const page = (place: string) => async () =>
      await read({ connectionId, feed: "folders", place, cursor: null });
    await expect(outcomeOf(page("inbox"))).resolves.toBe("ok");
    // The whole account through a sync of places, a path out of one
    // segment, and a place through a sync of the whole account: refused
    // before anything leaves.
    const refused = await Promise.all(
      ["own", "inbox/../../admin", "..", "a%2Fb", "a?b=1"].map(
        async (place) => await outcomeOf(page(place))
      )
    );
    await expect(
      outcomeOf(
        async () =>
          await read({
            connectionId,
            feed: "files",
            place: "inbox",
            cursor: null,
          })
      )
    ).resolves.toBe("sync.place_refused");
    expect({ refused, sent: sentToProvider() }).toStrictEqual({
      refused: Array.from({ length: 5 }, () => "sync.place_refused"),
      sent: ["/v1/me/folders/inbox/changes"],
    });
  });

  it("goes on with a list longer than one read from where the last read ended", async () => {
    const connectionId = await ownConnection();
    provider.folders = {
      "": { folders: ["inbox"], next: "2" },
      "2": { folders: ["archive"] },
    };
    const first = await places({ connectionId, feed: "folders", cursor: null });
    const second = await places({
      connectionId,
      feed: "folders",
      cursor: first.cursor,
    });
    expect({ first, second }).toStrictEqual({
      first: { places: ["inbox"], cursor: "2" },
      second: { places: ["archive"], cursor: null },
    });
  });

  it("reads no place of a shared connection's own account, through any sync", async () => {
    const shared = await addConnection({
      provider: "microsoft",
      serverKind: "native",
      server: "sample-sync",
      tenant: "acme",
    });
    await expect(
      outcomeOf(
        async () =>
          await read({
            connectionId: shared,
            feed: "folders",
            place: "inbox",
            cursor: null,
          })
      )
    ).resolves.toBe("sync.place_refused");
    expect(sentToProvider()).toStrictEqual([]);
  });

  it("refuses a list with one place that isn't one, whole", async () => {
    const connectionId = await ownConnection();
    provider.folders = { "": { folders: ["inbox", "../admin"] } };
    await expect(
      outcomeOf(
        async () =>
          await places({ connectionId, feed: "folders", cursor: null })
      )
    ).resolves.toBe("sync.provider_failed");
  });

  it("lists no place of a shared connection while none is picked, and nothing of a sync not declared", async () => {
    const shared = await addConnection({
      provider: "microsoft",
      serverKind: "native",
      server: "sample-sync",
      tenant: "acme",
    });
    const own = await ownConnection();
    await expect(
      places({ connectionId: shared, feed: "folders", cursor: null })
    ).resolves.toStrictEqual({ places: [], cursor: null });
    await expect(
      outcomeOf(
        async () =>
          await places({ connectionId: own, feed: "nothing", cursor: null })
      )
    ).resolves.toBe("sync.not_found");
    expect(sentToProvider()).toStrictEqual([]);
  });
});
