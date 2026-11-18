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

import { runSync } from "../src/brain-sync.ts";
import {
  idp,
  setUpTime,
  pollMs,
  markerOf,
  connectSampleFeed,
  mailItem,
  goneItem,
  feedPage,
  finds,
  clockAt,
  later,
  sync,
  ownSourcesOnly,
  parkWorkerSources,
} from "./brain-sync-world.ts";
import { mockIdpWith } from "./idp.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { signedInApi } from "./sign-in.ts";

mockIdpWith(idp);

// Native sync (src/brain-sync.ts, GRA-1758): removals: a page that removes and passes over, stopped at each step; an item that returns; a shared file gone from a folder. The shared world,
// fakes and clock are in test/brain-sync-world.ts.

describe("native sync", () => {
  beforeAll(parkWorkerSources, setUpTime.timeout);
  beforeEach(ownSourcesOnly);
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    "applies a page that removes and passes over, stopped at each step, and takes back what comes again",
    setUpTime,
    async () => {
      const [owner, colleague] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      const quiet = { changes: [], next: "c", more: false };
      await connectSampleFeed(colleague, { "": quiet, c: quiet });
      const [kept, mail, file, late] = [
        markerOf(),
        markerOf(),
        markerOf(),
        markerOf(),
      ];
      const tenant = [{ kind: "tenant", id: acmeTenant }];
      const shared = (id: string, text: string | null, version = "1") =>
        mailItem(id, text, { kind: "file", readers: tenant, version });
      const first = {
        changes: [
          mailItem("kept", `Kept ${kept}`),
          mailItem("mail", `Mail ${mail}`),
          shared("file", `File ${file}`),
          shared("late", `Late ${late}`),
        ],
        next: "p2",
        more: false,
      };
      const { post } = await connectSampleFeed(owner, {
        "": first,
        p2: { changes: [], next: "p2", more: false },
      });
      later(pollMs);
      await sync();
      // A message and a shared file gone, a file passed over at the
      // version held (its content late): stopped at each step in turn.
      await post({
        "": first,
        p2: {
          changes: [
            { gone: true, id: "mail", kind: "mail" },
            { gone: true, id: "file", kind: "file" },
            shared("late", null),
          ],
          next: "p3",
          more: false,
        },
        p3: { changes: [], next: "p3", more: false },
      });
      later(pollMs);
      for (let left = 6; left < 40; left += 1) {
        vi.useFakeTimers({ toFake: ["Date"], now: clockAt() });
        try {
          // oxlint-disable-next-line no-await-in-loop -- one run after another, as the clock runs them
          await runSync(env, { left });
        } finally {
          vi.useRealTimers();
        }
      }
      later(pollMs);
      await sync();
      const removed = {
        mail: await finds(owner.userId, mail),
        file: await finds(colleague.userId, file),
        late: await finds(colleague.userId, late),
        kept: await finds(owner.userId, kept),
      };
      // The message out of the bin as it was, the file at a new version,
      // the late one with its content after all.
      await post({
        "": first,
        p2: { changes: [], next: "p3", more: false },
        p3: {
          changes: [
            mailItem("mail", `Mail ${mail}`),
            shared("file", `File ${file}`, "2"),
            shared("late", `Late ${late}`),
          ],
          next: "p4",
          more: false,
        },
        p4: { changes: [], next: "p4", more: false },
      });
      later(pollMs);
      await sync();

      expect({
        removed,
        back: {
          mail: await finds(owner.userId, mail),
          file: await finds(colleague.userId, file),
          late: await finds(colleague.userId, late),
        },
      }).toStrictEqual({
        removed: { mail: false, file: false, late: true, kept: true },
        back: { mail: true, file: true, late: true },
      });
    }
  );

  it(
    "takes an item back that returns after a removal stopped at any step",
    setUpTime,
    async () => {
      const [owner, colleague] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      const quiet = { changes: [], next: "c", more: false };
      await connectSampleFeed(colleague, { "": quiet, c: quiet });
      const [mail, file] = [markerOf(), markerOf()];
      const tenant = [{ kind: "tenant", id: acmeTenant }];
      const message = mailItem("mail", `Mail ${mail}`);
      const fileAt = (version: string) =>
        mailItem("file", `File ${file} ${version}`, {
          kind: "file",
          readers: tenant,
          version,
        });
      const first = 6;
      const { post } = await connectSampleFeed(owner, {
        "": { changes: [message, fileAt("1")], next: `c${first}`, more: false },
        [`c${first}`]: { changes: [], next: `c${first}`, more: false },
      });
      later(pollMs);
      await sync();
      // For each step in turn: the message and the file go, the run stops
      // there, and the same position then names them back (the message as
      // it was, out of the bin; the file at a new version).
      const missing: number[] = [];
      for (let left = first; left < 30; left += 1) {
        const at = `c${left}`;
        const next = { changes: [], next: `c${left + 1}`, more: false };
        // oxlint-disable-next-line no-await-in-loop -- one step after another
        await post({
          [at]: {
            changes: [
              { gone: true, id: "mail", kind: "mail" },
              { gone: true, id: "file", kind: "file" },
            ],
            next: `d${left}`,
            more: false,
          },
        });
        later(pollMs);
        vi.useFakeTimers({ toFake: ["Date"], now: clockAt() });
        try {
          // oxlint-disable-next-line no-await-in-loop -- one step after another
          await runSync(env, { left });
        } finally {
          vi.useRealTimers();
        }
        const back = {
          changes: [message, fileAt(String(left))],
          next: `c${left + 1}`,
          more: false,
        };
        // oxlint-disable-next-line no-await-in-loop -- one step after another
        await post({ [at]: back, [`d${left}`]: back, [`c${left + 1}`]: next });
        later(pollMs);
        // oxlint-disable-next-line no-await-in-loop -- one step after another
        await sync();
        if (
          // oxlint-disable-next-line no-await-in-loop -- read after each step
          !(await finds(owner.userId, mail)) ||
          // oxlint-disable-next-line no-await-in-loop -- read after each step
          !(await finds(colleague.userId, `${file} ${left}`))
        ) {
          missing.push(left);
        }
      }

      expect(missing).toStrictEqual([]);
    }
  );

  it(
    "never holds the removal of what others may read: a shared file gone from a folder goes at once",
    setUpTime,
    async () => {
      const [owner, colleague] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      const quiet = feedPage([], "q");
      await connectSampleFeed(colleague, { "": quiet, q: quiet });
      const marker = markerOf();
      const { world } = await connectSampleFeed(owner, { "": quiet, q: quiet });
      const shared = mailItem("a/f", `Plan ${marker}`, {
        kind: "file",
        readers: [{ kind: "tenant", id: acmeTenant }],
      });
      const a: Record<string, unknown> = {
        "": feedPage([shared], "a1"),
        a1: feedPage([], "a1"),
      };
      const b = { "": feedPage([], "b1"), b1: feedPage([], "b1") };
      await world({
        places: ["a", "b"],
        folders: { a: { changes: a }, b: { changes: b } },
        failing: [],
      });
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();
      const before = await finds(colleague.userId, marker);
      // Gone from a while b fails, which would hold a removal.
      a.a1 = feedPage([goneItem("a/f")], "a2");
      a.a2 = feedPage([], "a2");
      await world({
        folders: { a: { changes: a }, b: { changes: b } },
        failing: ["b"],
      });
      later(pollMs);
      await sync();

      expect({
        before,
        after: await finds(colleague.userId, marker),
      }).toStrictEqual({ before: true, after: false });
    }
  );
});
