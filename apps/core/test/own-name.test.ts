import { guestRole } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  whoami,
} from "./sign-in.ts";

// A person's own name. The ways it can fail, first:
//
// - Someone changing a name not theirs: the call names no one, so it can
//   only be the caller's own; another member's name stays.
// - Someone who isn't a member changing theirs: Grasp staff, who never
//   act inside the client's workspace, and a guest, who reaches only what
//   guest-access.ts opens to them.
// - A name that isn't one: nothing, too long, or one that breaks the line
//   it is shown on or turns the text around it (controls, separators,
//   bidi controls).
// - A stale name: their own connection, or the member list, still showing
//   the old one.
// - The audit log: no event, one per call rather than per change, or the
//   name itself in it.
// - Their next sign-in putting back what the IdP calls them.

const idp = mockIdp();

/** `userId`'s name as stored. */
const storedName = async (userId: string): Promise<string | null> =>
  await env.DB.prepare("SELECT name FROM users WHERE id = ?")
    .bind(userId)
    .first<string>("name");

describe("a person's own name", { timeout: 60_000 }, () => {
  it("is theirs to change, shows at once, is audited once, and stays through their next sign-in", async () => {
    const me = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const { name: theirName } = await whoami(admin.session);

    const audited = await auditedDuring(async () => {
      await me.api.setName("  Sam de Vries  ");
      // The same name again changes nothing, and records nothing more.
      await me.api.setName("Sam de Vries");
    });
    // Their own connection, read a moment after, and the admin's list.
    const { name: onTheirConnection } = await me.api.whoami();
    const members = await admin.api.members.list();
    const listed = members.find(({ userId }) => userId === me.userId)?.name;
    // Signing in again, the IdP now calling them something else.
    const again = await signedIn(idp, "microsoft", {
      ...me.person,
      name: "Samuel de Vries",
    });
    const { name: afterSignIn } = await whoami(again);
    const { name: theirs } = await whoami(admin.session);

    expect({
      audited: audited.map(({ actor, action, target, detail }) => ({
        actor,
        action,
        target,
        detail,
      })),
      onTheirConnection,
      listed,
      afterSignIn,
      theirs,
    }).toStrictEqual({
      audited: [
        {
          actor: { type: "person", userId: me.userId },
          action: "member.name.updated",
          target: { type: "user", id: me.userId },
          // Who, never the name.
          detail: {},
        },
      ],
      onTheirConnection: "Sam de Vries",
      listed: "Sam de Vries",
      afterSignIn: "Sam de Vries",
      theirs: theirName,
    });
  });

  it("takes a name of up to 100 characters on one line that shows, and nothing else", async () => {
    const me = await signedInApi(idp, "user");
    const refused = await Promise.all(
      [
        "",
        " \t ",
        "x".repeat(101),
        "\u{20000}".repeat(101),
        "Sam\nde Vries",
        "Sam\u2028de Vries",
        "Sam\u0000",
        // A right-to-left override, and an isolate: the name would read
        // backwards, or carry the text after it along.
        "\u202Eseirv ed maS",
        "Sam\u2067de Vries",
        // Blank to the eye: a zero-width space, a word joiner, a soft
        // hyphen, a Hangul filler.
        "\u200B",
        "\u2060",
        "\u00AD",
        "\u3164",
      ].map(async (name) => await outcome(me.api.setName(name)))
    );
    const kept = await storedName(me.userId);
    const accepted = [
      "x".repeat(100),
      // 100 characters, though each (a rare CJK one) is two UTF-16 units.
      "\u{20000}".repeat(100),
      // A zero-width joiner inside an emoji beside a name.
      "Sam \u{1F469}\u200D\u{1F4BB}",
      // A name in a right-to-left script needs no bidi control.
      "\u0633\u0627\u0645 \u062F\u064A \u0641\u0631\u064A\u0633",
    ];
    const stored: (string | null)[] = [];
    for (const name of accepted) {
      // One after another: each is the name the next one replaces.
      // oxlint-disable-next-line no-await-in-loop
      await me.api.setName(name);
      // oxlint-disable-next-line no-await-in-loop
      stored.push(await storedName(me.userId));
    }

    expect({ refused: new Set(refused), kept, stored }).toStrictEqual({
      refused: new Set(["member.name_invalid"]),
      kept: me.person.name,
      stored: accepted,
    });
  });

  it("is refused to a member removed since their session was read, and their name stays", async () => {
    const me = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    // Their connection reads who they are now, and holds that reading on
    // a held clock, so the call below is answered from it, removed or not.
    await me.api.whoami();
    vi.useFakeTimers({ toFake: ["Date"] });
    let renamed: string;
    try {
      await admin.api.members.remove(me.userId);
      renamed = await outcome(me.api.setName("Still Here"));
    } finally {
      vi.useRealTimers();
    }

    expect({ renamed, name: await storedName(me.userId) }).toStrictEqual({
      renamed: "auth.unauthenticated",
      name: me.person.name,
    });
  });

  it("is refused to Grasp staff and to a guest, and their names stay", async () => {
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const staff = await whoami(staffSession);
    const { core: staffCore } = await openRpc(staffSession);

    const guest = await signedInApi(idp, "user");
    await env.DB.prepare("UPDATE members SET role = ? WHERE user_id = ?")
      .bind(guestRole, guest.userId)
      .run();
    const { core: guestCore } = await openRpc(guest.session);

    const outcomes = {
      staff: await outcome(staffCore.authenticate().setName("Not Staff")),
      guest: await outcome(guestCore.authenticate().setName("Not a Guest")),
    };

    expect({
      outcomes,
      staffName: await storedName(staff.userId),
      guestName: await storedName(guest.userId),
    }).toStrictEqual({
      outcomes: { staff: "role.forbidden", guest: "auth.unauthenticated" },
      staffName: staff.name,
      guestName: guest.person.name,
    });
  });
});
