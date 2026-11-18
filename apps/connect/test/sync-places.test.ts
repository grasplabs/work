import { connectionErrors } from "@grasp-os/shared/connect";
import { roleErrors } from "@grasp-os/shared/roles";
import { syncErrors } from "@grasp-os/shared/sync";
import type { SyncPageRequest, SyncPlacesRequest } from "@grasp-os/shared/sync";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { connections } from "../src/db/schema.ts";
import {
  addConnection,
  auditEvents,
  connectAccount,
  mailboxAccount,
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
// Then a shared connection's picked places (`sites`, `places: "picked"`):
// a place read that no admin picked; a picked place read through a
// person's own connection, or the connected account's own mail and files
// through a shared one; a place unpicked or gone still listed; someone
// other than an admin picking, or a pick without its audit event; a
// planted name shown as something else.

const providers = fakeProviders();

/**
 * What the sample provider answers, for each test to set: its folders, a
 * page of them a read, by where the last page ended.
 */
const provider: {
  folders: Record<string, unknown>;
  sites: Record<string, unknown>;
} = {
  folders: { "": { folders: ["inbox", "archive"] } },
  sites: {},
};

const internet = fakeInternet((_request, url) => {
  if (url.pathname === "/v1/me/folders") {
    return Response.json(
      provider.folders[url.searchParams.get("from") ?? ""] ?? {}
    );
  }
  if (url.pathname === "/v1/sites") {
    return Response.json(
      provider.sites[url.searchParams.get("from") ?? ""] ?? { sites: [] }
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
    return (
      syncErrors.codeOf(error) ??
      roleErrors.codeOf(error) ??
      connectionErrors.codeOf(error) ??
      String(error)
    );
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

const audit = auditEvents();

const sales = { id: "sales", name: "Sales" };
const legal = { id: "legal", name: "Legal" };
const board = { id: "board", name: "Board" };

/** A connection an admin made for the company, of the sample sync. */
const sharedConnection = async (): Promise<{
  admin: ReturnType<typeof someone>;
  connectionId: string;
}> => {
  provider.sites = { "": { sites: [sales, legal, board] } };
  const admin = someone("admin");
  const connectionId = await connectAccount(
    providers,
    admin,
    mailboxAccount(),
    { scope: "shared" }
  );
  await drizzle(env.DB)
    .update(connections)
    .set({ server: "sample-sync" })
    .where(eq(connections.id, connectionId));
  return { admin, connectionId };
};

const pick = async (
  person: ReturnType<typeof someone>,
  connectionId: string,
  picked: string[]
) =>
  await exports.default.pickSyncPlaces({
    person,
    connectionId,
    feed: "sites",
    places: picked,
  });

/** What a site's page read answered, or the code it was refused with. */
const siteRead = async (connectionId: string, place: string) =>
  await outcomeOf(
    async () => await read({ connectionId, feed: "sites", place, cursor: null })
  );

/** What an admin's pick, or its refusal, recorded, for one connection. */
const picksRecorded = async (connectionId: string) => {
  const events = await audit.events();
  return events
    .filter(
      ({ action, target }) =>
        action === "connection.sync_places" && target?.id === connectionId
    )
    .map(({ actor, detail }) => ({
      actor: "userId" in actor ? actor.userId : actor.type,
      detail,
    }));
};

describe("a shared connection's picked places", () => {
  it("reads only the places an admin picked, and lists them while its connector still does", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, ["sales", "legal"]);
    const before = sentToProvider().length;

    const listed = await places({ connectionId, feed: "sites", cursor: null });
    const reads = {
      sales: await siteRead(connectionId, "sales"),
      board: await siteRead(connectionId, "board"),
      own: await siteRead(connectionId, "own"),
    };

    expect({
      listed,
      reads,
      sent: sentToProvider().slice(before),
    }).toStrictEqual({
      listed: { places: ["sales", "legal"], cursor: null },
      // A place nobody picked, and the connected account's own: refused
      // before anything leaves.
      reads: {
        sales: "ok",
        board: "sync.place_refused",
        own: "sync.place_refused",
      },
      sent: ["/v1/sites", "/v1/sites/sales/changes"],
    });
  });

  it("drops a place once it is unpicked, or once its connector no longer lists it", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, ["sales", "legal"]);

    await pick(admin, connectionId, ["legal"]);
    const unpicked = {
      listed: await places({ connectionId, feed: "sites", cursor: null }),
      read: await siteRead(connectionId, "sales"),
    };
    // The account can no longer see Legal: it is no place any more, picked
    // or not, so core drops its source and erases what it brought.
    provider.sites = { "": { sites: [sales, board] } };
    const gone = await places({ connectionId, feed: "sites", cursor: null });

    expect({ unpicked, gone }).toStrictEqual({
      unpicked: {
        listed: { places: ["legal"], cursor: null },
        read: "sync.place_refused",
      },
      gone: { places: [], cursor: null },
    });
  });

  it("goes on with a listing longer than one read, keeping only picked places", async () => {
    const { admin, connectionId } = await sharedConnection();
    provider.sites = {
      "": { sites: [sales, board], next: "2" },
      "2": { sites: [legal] },
    };
    await pick(admin, connectionId, ["legal", "sales"]);
    const first = await places({ connectionId, feed: "sites", cursor: null });
    const second = await places({
      connectionId,
      feed: "sites",
      cursor: first.cursor,
    });
    expect({ first, second }).toStrictEqual({
      first: { places: ["sales"], cursor: "2" },
      second: { places: ["legal"], cursor: null },
    });
  });

  it("never takes a picked place through a person's own connection, nor their own account through a shared one", async () => {
    const own = await ownConnection();
    const { admin, connectionId: shared } = await sharedConnection();
    await pick(admin, shared, ["sales"]);
    const before = sentToProvider().length;

    const outcomes = {
      ownPicked: await siteRead(own, "sales"),
      ownPlaces: await places({
        connectionId: own,
        feed: "sites",
        cursor: null,
      }),
      sharedFiles: await outcomeOf(
        async () =>
          await read({
            connectionId: shared,
            feed: "files",
            place: "own",
            cursor: null,
          })
      ),
      sharedFolders: await places({
        connectionId: shared,
        feed: "folders",
        cursor: null,
      }),
      pickOnOwn: await outcomeOf(
        async () => await pick(someone("admin"), own, ["sales"])
      ),
    };

    expect({ outcomes, sent: sentToProvider().slice(before) }).toStrictEqual({
      outcomes: {
        ownPicked: "sync.place_refused",
        ownPlaces: { places: [], cursor: null },
        sharedFiles: "sync.place_refused",
        sharedFolders: { places: [], cursor: null },
        pickOnOwn: "sync.not_shared",
      },
      sent: [],
    });
  });

  it("lets only the company's admins pick, recording each change once and every refusal", async () => {
    const { admin, connectionId } = await sharedConnection();
    const member = someone();
    const staff = { ...someone("admin"), staff: true };

    const refused = {
      member: await outcomeOf(
        async () => await pick(member, connectionId, ["sales"])
      ),
      staff: await outcomeOf(
        async () => await pick(staff, connectionId, ["sales"])
      ),
    };
    await pick(admin, connectionId, ["sales", "legal"]);
    // The same places again change nothing and record nothing.
    await pick(admin, connectionId, ["legal", "sales"]);
    await pick(admin, connectionId, ["board"]);

    expect({
      refused,
      listed: await places({ connectionId, feed: "sites", cursor: null }),
      recorded: await picksRecorded(connectionId),
    }).toStrictEqual({
      refused: {
        member: "role.forbidden",
        staff: "connection.staff_not_allowed",
      },
      listed: { places: ["board"], cursor: null },
      recorded: [
        {
          actor: member.userId,
          detail: {
            feed: "sites",
            outcome: "refused",
            reason: "role.forbidden",
          },
        },
        {
          actor: staff.userId,
          detail: {
            feed: "sites",
            outcome: "refused",
            reason: "connection.staff_not_allowed",
          },
        },
        {
          actor: admin.userId,
          detail: {
            feed: "sites",
            outcome: "ok",
            places: 2,
            added: 2,
            removed: 0,
          },
        },
        {
          actor: admin.userId,
          detail: {
            feed: "sites",
            outcome: "ok",
            places: 1,
            added: 1,
            removed: 2,
          },
        },
      ],
    });
  });

  it("shows an admin what they may pick, with what is picked, and names only as data", async () => {
    const { admin, connectionId } = await sharedConnection();
    provider.sites = {
      "": {
        sites: [
          sales,
          // A name planted to show as something else: a bidirectional
          // override and a line break.
          { id: "legal", name: "Le\u202Egal\nTeam  " },
        ],
      },
    };
    await pick(admin, connectionId, ["legal"]);
    const member = someone();

    expect({
      choices: await exports.default.syncPlaceChoices({
        person: admin,
        connectionId,
        feed: "sites",
        cursor: null,
      }),
      member: await outcomeOf(
        async () =>
          await exports.default.syncPlaceChoices({
            person: member,
            connectionId,
            feed: "sites",
            cursor: null,
          })
      ),
    }).toStrictEqual({
      choices: {
        choices: [
          { place: "sales", title: "Sales", picked: false },
          { place: "legal", title: "Legal Team", picked: true },
        ],
        cursor: null,
      },
      member: "role.forbidden",
    });
  });

  it("refuses a pick that steps out of one place, whole", async () => {
    const { admin, connectionId } = await sharedConnection();
    await pick(admin, connectionId, ["sales"]);
    const refused = await Promise.all(
      [["../admin"], ["own"], ["sales", "sales"], ["a/b"]].map(
        async (picked) =>
          await outcomeOf(async () => await pick(admin, connectionId, picked))
      )
    );
    expect({
      refused,
      listed: await places({ connectionId, feed: "sites", cursor: null }),
    }).toStrictEqual({
      refused: Array.from({ length: 4 }, () => "sync.invalid"),
      listed: { places: ["sales"], cursor: null },
    });
  });
});
