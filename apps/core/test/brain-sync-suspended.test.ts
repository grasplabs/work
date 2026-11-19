import { env } from "cloudflare:workers";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import {
  connectSampleFeed,
  feedPage,
  finds,
  idp,
  later,
  mailItem,
  markerOf,
  ownSourcesOnly,
  parkWorkerSources,
  pollMs,
  setUpTime,
  sync,
} from "./brain-sync-world.ts";
import {
  connectedDirectory,
  directoryHolds,
  directoryUser as user,
} from "./directory.ts";
import { mockIdpWith } from "./idp.ts";
import { runClockTask } from "./maintenance.ts";
import { acmeTenant, entraClient } from "./sign-in-config.ts";
import {
  entraPerson,
  openRpc,
  signedIn,
  whoami,
  withSignIn,
} from "./sign-in.ts";

mockIdpWith(idp);

// The Brain's sync of a person's own connection while the directory has
// them suspended (GRA-2143, slice 3c of GRA-2056): their token is used for
// nothing in the background, their sources wait where they were, and the
// sync goes on from there once the suspension lifts. The shared world,
// fakes and clock are in test/brain-sync-world.ts.

const dayMs = 24 * 60 * 60 * 1000;
let days = 0;
/** The directory's daily read, a read later than the last. */
const directoryRead = async (): Promise<void> => {
  days += 2;
  await runClockTask(
    "directory.people",
    {},
    new Date(Date.now() + days * dayMs)
  );
};

/** Someone who signed in with Microsoft under a directory object ID, as a member. */
const memberInDirectory = async () => {
  const person = entraPerson(acmeTenant, "acme.test", {
    oid: crypto.randomUUID(),
  });
  const session = await signedIn(idp, "microsoft", person, {
    coreEnv: withSignIn({
      admins: [String(person.email)],
      entra: { tenantId: acmeTenant, clientId: entraClient.id },
    }),
  });
  const { userId } = await whoami(session);
  await env.DB.prepare("UPDATE members SET role = 'user' WHERE user_id = ?")
    .bind(userId)
    .run();
  const { core, closed } = await openRpc(session);
  return { session, userId, person, core, closed, api: core.authenticate() };
};

describe("native sync of a suspended member", () => {
  beforeAll(parkWorkerSources, setUpTime.timeout);
  beforeEach(ownSourcesOnly);
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    "reads nothing of their own connection while the directory has them suspended, and goes on from where it was once it lifts",
    setUpTime,
    async () => {
      await connectedDirectory(idp);
      const owner = await memberInDirectory();
      const oid = String(owner.person.oid);
      const [first, meanwhile] = [markerOf(), markerOf()];
      const { post, world } = await connectSampleFeed(owner, {
        "": feedPage([mailItem("m1", `Note ${first}`)], "c1"),
        c1: feedPage([], "c1"),
      });
      // Its folders list as none.
      await world({ places: [] });
      later(pollMs);
      await sync();
      const before = await finds(owner.userId, first);
      // Turned off in the directory: suspended.
      await directoryHolds([user({ id: oid, accountEnabled: false })]);
      await directoryRead();
      // A mail arrives while they are suspended; the sync runs.
      await post({
        "": feedPage([mailItem("m1", `Note ${first}`)], "c1"),
        c1: feedPage([mailItem("m2", `Note ${meanwhile}`)], "c2"),
        c2: feedPage([], "c2"),
      });
      later(pollMs);
      await sync();
      // Turned on again: lifted, and nothing synced in between.
      await directoryHolds([user({ id: oid })]);
      await directoryRead();
      const notYet = await finds(owner.userId, meanwhile);
      later(pollMs);
      await sync();

      expect({
        before,
        notYet,
        afterLift: await finds(owner.userId, meanwhile),
      }).toStrictEqual({ before: true, notYet: false, afterLift: true });
    }
  );
});
