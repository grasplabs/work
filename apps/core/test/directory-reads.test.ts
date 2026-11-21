import { describe, expect, it } from "vite-plus/test";

import {
  connectedDirectory,
  deletedFailAt,
  directoryFailsAt,
  directoryHolds,
  directoryUser as user,
} from "./directory.ts";
import { mockIdp } from "./idp.ts";
import { runClockTask } from "./maintenance.ts";
import {
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// Where the directory's daily read stands, as the client's admins see it
// in Settings (GRA-2056, slice 4; GRA-2144): when it was last applied, and
// what went wrong since, which nothing else shows them. Only Microsoft
// Graph is faked. What could go wrong: a failure an admin never learns of,
// an old read shown as current, or the status read by someone it isn't for.

const idp = mockIdp();
const dayMs = 24 * 60 * 60 * 1000;

let days = 0;
/** A time past every read so far by more than a day: a read is due then. */
const nextDay = (): Date => {
  days += 2;
  return new Date(Date.now() + days * dayMs);
};

/** The clock's daily read, run for the slot at `at`. */
const readAt = async (at: Date): Promise<void> => {
  await runClockTask("directory.people", {}, at);
};

describe("where the directory's daily read stands", () => {
  it("shows nothing before a read was tried, then the read applied with its counts, then each failure since without moving the read, until one is applied again", async () => {
    const { admin } = await connectedDirectory(idp);
    const before = await admin.api.members.directoryReads();
    await directoryHolds([user(), user(), user({ accountEnabled: false })]);
    const started = Date.now();
    await readAt(nextDay());
    const [applied] = await admin.api.members.directoryReads();
    await directoryHolds(Array.from({ length: 150 }, () => user()));
    await directoryFailsAt(100);
    await readAt(nextDay());
    const [failed] = await admin.api.members.directoryReads();
    await directoryHolds([user()]);
    await readAt(nextDay());
    const [again] = await admin.api.members.directoryReads();

    expect(before).toStrictEqual([]);
    expect({
      ...applied,
      readAt: Date.parse(applied?.readAt ?? "") >= started,
    }).toStrictEqual({
      provider: "microsoft-directory",
      readAt: true,
      people: 2,
      disabled: 1,
      failure: null,
      deletedFailure: null,
    });
    expect({
      ...failed,
      failure: { ...failed?.failure, at: failed?.failure?.at !== undefined },
    }).toStrictEqual({
      ...applied,
      failure: { code: "directory.provider_failed", at: true },
    });
    expect({
      failure: again?.failure,
      people: again?.people,
      newer:
        Date.parse(again?.readAt ?? "") > Date.parse(applied?.readAt ?? ""),
    }).toStrictEqual({ failure: null, people: 1, newer: true });
  });

  it("says when the read went without the deleted accounts, and no longer once it read them again", async () => {
    const { admin } = await connectedDirectory(idp);
    await directoryHolds([user()]);
    await deletedFailAt(0, 403);
    await readAt(nextDay());
    const [refused] = await admin.api.members.directoryReads();
    await directoryHolds([user()]);
    await readAt(nextDay());
    const [read] = await admin.api.members.directoryReads();

    expect({
      refused: [refused?.failure, refused?.deletedFailure],
      read: [read?.failure, read?.deletedFailure],
    }).toStrictEqual({
      refused: [null, "directory.deleted_refused"],
      read: [null, null],
    });
  });

  it("is the client's admins' alone: a member and Grasp staff are refused", async () => {
    await connectedDirectory(idp);
    await directoryHolds([user()]);
    await readAt(nextDay());
    const member = await signedInApi(idp, "user");
    const staff = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );

    expect({
      member: await outcome(member.api.members.directoryReads()),
      staff: await outcome(staff.core.authenticate().members.directoryReads()),
    }).toStrictEqual({ member: "role.forbidden", staff: "role.forbidden" });
  });
});
