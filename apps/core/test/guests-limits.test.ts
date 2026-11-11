import { env } from "cloudflare:workers";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";

import { sweepGuestChats } from "../src/guests.ts";
import {
  answering,
  ask,
  call,
  connected,
  guest,
  guestApp,
  idp,
  invite,
  invitedSchema,
  literalRows,
  reply,
} from "./guests-harness.ts";
import { mockIdpWith } from "./idp.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// Guest chats (src/guests.ts) through an App's sealed functions: a guests
// resource its actions declare (`resource.guests`), which reaches nothing
// until an admin binds it to one of the App's permissions to invite
// guests (resource-guests.ts). An App invites someone who isn't a member
// to a chat with a model through a link. The ways it can fail, each tried
// below before anything else:
//
// - A declaration that grants itself, a binding naming another App's
//   permission, or one serving a version that declares more than was
//   approved.
// - A link that opens more than its one chat: a made-up or malformed
//   secret, another App reading the chat, a request in any other shape.
// - A link that outlives its purpose: past its expiry, revoked, finished,
//   its App's permission or binding revoked, or the member it was made for
//   gone.
// - A guest reaching anything but the model: the model is called with no
//   tools, only the chat's guide and the chat, and as the guest, for the
//   member, through the gateway.
// - A guest spending without bound: two messages at once, more than 20
//   turns, messages over 1,000 characters, a failed call taking a turn.
// - An App inviting without bound or for someone else: with a skill the
//   release doesn't have, more than 50 open.
// - Nothing on record: every step audited, as whom.
// - Kept forever: chats deleted 30 days after they end.
//
// A workflow never reaches guest chats: an independent workflow calls an
// App only through its public queries and mutations
// (workflows/app-calls.ts), never an action, and the guests resource is an
// action's.
// The test of a run listing, reading and revoking chats through
// `env.APP.callFunction` went with App-owned TypeScript workflows.

mockIdpWith(idp);

describe("guest chats", { timeout: 60_000 }, () => {
  beforeEach(connected);

  afterEach(() => {
    vi.useRealTimers();
  });

  it("list an App's open chats first, however many ended since, so each can be revoked", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const oldest = await invite(app, builder.userId, { name: "Still open" });
    for (let chat = 0; chat < 101; chat += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one chat at a time
      const made = await invite(app, builder.userId);
      // oxlint-disable-next-line no-await-in-loop -- finished before the next
      await guest({ action: "finish", token: made.token });
    }
    const newest = await invite(app, builder.userId, { name: "Newest open" });
    const { ok: listed } = z
      .object({
        ok: z.array(z.object({ id: z.string(), status: z.string() })),
      })
      .parse(await call(app, builder.userId, "list"));
    expect({
      listed: listed.length,
      first: listed.slice(0, 2),
      rest: [...new Set(listed.slice(2).map(({ status }) => status))],
    }).toStrictEqual({
      listed: 100,
      first: [
        { id: newest.id, status: "open" },
        { id: oldest.id, status: "open" },
      ],
      rest: ["finished"],
    });
  });

  it("are invited only by a person using the App, with a Grasp skill, at most 50 open at once", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const refusals = {
      unknownSkill: await ask(app, builder.userId, { skill: "run-anything" }),
      tooLong: await ask(app, builder.userId, { days: 15 }),
      noName: await ask(app, builder.userId, { name: " " }),
    };
    const open: string[] = [];
    for (let chat = 0; chat < 50; chat += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one invitation at a time
      const made = await invite(app, builder.userId);
      open.push(made.id);
    }
    const fiftyFirst = await ask(app, builder.userId);
    await call(app, builder.userId, "revoke", { id: open[0] });
    const afterRevoke = invitedSchema.safeParse(
      await ask(app, builder.userId)
    ).success;
    expect({ ...refusals, fiftyFirst, afterRevoke }).toStrictEqual({
      unknownSkill: { error: "resource.invalid_args" },
      tooLong: { error: "resource.invalid_args" },
      noName: { error: "resource.invalid_args" },
      fiftyFirst: {
        error: "resource.limit_reached",
        details: { limit: "open" },
      },
      afterRevoke: true,
    });
  });

  it("need a permission of their own: a platform permission does one thing, and only an App asks for it", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({
      name: `Asks ${unique()}`,
    });
    const request = async (
      asked: Parameters<typeof builder.api.permissions.request>[0]
    ) => await outcome(builder.api.permissions.request(asked));
    expect({
      both: await request({
        subject: { type: "app", appId: app },
        object: { type: "platform" },
        actions: ["statistics", "guests"],
        binding: "PLATFORM",
      }),
      agent: await request({
        subject: { type: "agent", agentId: "organization" },
        object: { type: "platform" },
        actions: ["guests"],
        binding: "GUESTS",
      }),
      app: await request({
        subject: { type: "app", appId: app },
        object: { type: "platform" },
        actions: ["guests"],
        binding: "GUESTS",
      }),
    }).toStrictEqual({
      both: "permission.invalid",
      agent: "permission.invalid",
      app: "ok",
    });
  });

  it("find chats and their messages by index, reading no table whole", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const { id, token } = await invite(app, builder.userId);
    const recorded = await recordedQueries(async () => {
      await answering([reply("What do you do?")], async () => {
        await guest({ action: "open", token });
        await guest({ action: "send", token, text: "I close the month." });
      });
      await call(app, builder.userId, "list");
      await call(app, builder.userId, "read", { id });
      await invite(app, builder.userId);
      await guest({ action: "finish", token });
      await sweepGuestChats(env, new Date());
    });
    const ofGuests = recorded.filter(({ query }) => query.includes("guest_"));
    const plans = await Promise.all(
      ofGuests.map(async (query) => await planOf(query))
    );
    const steps = plans.flat();
    expect({
      open: steps.some((step) => step.includes("guest_chats_open_idx")),
      read: ofGuests.length > 0,
      scans: steps.filter(
        (step) => fullScan.test(step) && !literalRows.test(step)
      ),
      sorts: steps.filter((step) => step.includes("TEMP B-TREE")),
    }).toStrictEqual({ open: true, read: true, scans: [], sorts: [] });
  });

  it("are deleted with what was written 30 days after they end, and not before", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const ended = await invite(app, builder.userId);
    await guest({ action: "finish", token: ended.token });
    const open = await invite(app, builder.userId, { days: 14 });
    const day = 24 * 60 * 60 * 1000;
    const readable = async (id: string): Promise<boolean> =>
      "ok" in
      z
        .record(z.string(), z.unknown())
        .parse(await call(app, builder.userId, "read", { id }));
    await sweepGuestChats(env, new Date(Date.now() + 29 * day));
    const before = [await readable(ended.id), await readable(open.id)];
    // A sweep deletes 100 at most, the oldest first, and the file's other
    // tests left more than that: the clock's next runs take the rest.
    const later = new Date(Date.now() + 31 * day);
    for (let run = 0; run < 4; run += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one run after another
      await sweepGuestChats(env, later);
    }
    expect({
      before,
      ended: await call(app, builder.userId, "read", { id: ended.id }),
      open: await readable(open.id),
    }).toStrictEqual({
      before: [true, true],
      ended: { error: "resource.item_not_found" },
      open: true,
    });
  });
});
