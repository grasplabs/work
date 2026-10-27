import { describe, expect, it } from "vite-plus/test";

import {
  boardPageOf,
  call,
  codeOf,
  idSchema,
  listed,
  opened,
  seedMap,
  take,
  valueOf,
} from "./board-page.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring, signedInApi } from "./sign-in.ts";

// The board page, the built-in App (apps/core/blueprints/board-page/):
// it takes snapshots of the workflow map's numbers, in its own store, shows
// the newest, and saves its narrative and the decision it asks for,
// keeping what the snapshot froze. A snapshot freezes each workflow's
// hours as drawn, designed and as it runs, read from the map (an `app`
// resource an admin binds to a workflow map), and the improvement signals
// of the App workflows the map links to, read from the platform's
// statistics (bound to the permission an admin grants). These tests go in
// through the Apps' functions, as their screens call them, and start from
// the ways it can fail: a number that isn't what the map and the runs say
// (a run outside the window counted, the designed version taken for the
// drawn one); a later save, run or day of signals changing a snapshot
// taken before it; a save of the narrative changing what it froze; a
// signal's subject (a person) or another App's signals frozen; part of a
// snapshot frozen; and someone who isn't one of its builders taking or
// writing one, or a snapshot taken from a map nobody bound.

const idp = mockIdp();
const { setUp } = boardPageOf(idp);

describe("the board page", { timeout: 90_000 }, () => {
  it("lists the snapshot taken last first, however many were taken that day", async () => {
    const { admin, app } = await setUp();
    const first = idSchema.parse(valueOf(await take(admin, app)));
    const second = idSchema.parse(valueOf(await take(admin, app)));
    const third = idSchema.parse(valueOf(await take(admin, app)));
    await expect(listed(admin, app)).resolves.toStrictEqual([
      third,
      second,
      first,
    ]);
  });

  it("is read by everyone it is shared with, taken and written by its builders alone, refused before anything is read for anyone else", async () => {
    const { admin, app, map } = await setUp();
    await seedMap(admin, map);
    const taken = idSchema.parse(valueOf(await take(admin, app)));
    const { snapshot } = await opened(admin, app, taken);
    const member = await signedInApi(idp, "user");
    await admin.api.apps.members.add(app, {
      type: "person",
      id: member.userId,
      role: "user",
    });
    let refused = "";
    const events = await auditedDuring(async () => {
      refused = codeOf(await take(member, app));
    });
    expect({
      take: refused,
      // Neither the map nor the statistics were read for them.
      read: events.filter(
        ({ action }) => action === "statistics.read" || action === "app.call"
      ).length,
      write: codeOf(
        await call(member, app, "snapshots.write", "mutation", {
          id: taken,
          expectedRevision: snapshot._rev,
          decisionNeeded: "",
          narrative: "Theirs.",
        })
      ),
      writable: valueOf(await call(member, app, "access.writable", "action")),
      listed: await listed(member, app),
      opened: await opened(member, app, taken).then(
        (read) => read.snapshot.narrative
      ),
      level: codeOf(await take(admin, app, { maturity: 6 })),
    }).toStrictEqual({
      take: "data.access_denied",
      read: 0,
      write: "data.write_denied",
      writable: false,
      listed: [taken],
      opened: "",
      level: "contract.invalid_args",
    });
  });

  it("takes no snapshot of a map nobody bound it to", async () => {
    const { admin, app } = await setUp({ bindMap: false });
    expect({
      taken: codeOf(await take(admin, app)),
      listed: await listed(admin, app),
    }).toStrictEqual({ taken: "resource.unavailable", listed: [] });
  });
});
