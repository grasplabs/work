import { guestTurnsMax } from "@grasp-os/shared/guests";
import { appIdSchema } from "@grasp-os/shared/ids";
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

import { grantReviewed, release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import {
  answering,
  ask,
  bindGuests,
  call,
  codeOf,
  connected,
  grantGuests,
  guest,
  guestApp,
  guestFiles,
  idp,
  invite,
  readsMessages,
  reply,
  send,
  viewOf,
} from "./guests-harness.ts";
import { mockIdpWith } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import { leave } from "./runs.ts";
import { failure } from "./sealed-apps.ts";
import { routed, signedInApi, unique } from "./sign-in.ts";

// Guest chats (src/guests.ts) through an App's sealed functions: a guests
// resource its actions declare (`permission.guests`), which reaches nothing
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

  it("let a guest chat through the link with a model that has only the guide and the chat, all of it on record", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const { id, token, link } = await invite(app, builder.userId);

    const [opened, again] = [
      await guest({ action: "open", token }),
      await guest({ action: "open", token }),
    ];
    const { first, second, requests } = await answering(
      [reply("What do you do most weeks?"), reply("How long does that take?")],
      async (provider) => ({
        first: await guest({
          action: "send",
          token,
          text: "I close the month.",
        }),
        second: await guest({ action: "send", token, text: "  Three days.  " }),
        requests: provider.requests,
      })
    );
    const read = z
      .object({
        ok: z.object({
          messages: z.array(z.object({ role: z.string(), text: z.string() })),
        }),
      })
      .parse(await call(app, builder.userId, "read", { id }));
    const bodies = requests.map(({ body }) => JSON.stringify(body));
    const logged = await allEvents();
    const events = logged.filter(
      ({ target, provenance }) => target?.id === id || provenance.includes(id)
    );

    expect({
      link: new URL(link).pathname,
      secret: token.length,
      opened: viewOf(opened),
      again: again.status,
      first: viewOf(first).turnsLeft,
      second: viewOf(second).messages,
      read: read.ok.messages,
      // Only the guide, the bounds and the chat; no tools, nothing else.
      guide: bodies.every((body) => body.includes("Interview a stakeholder")),
      bounds: bodies.every((body) => body.includes("You have no tools")),
      tools: bodies.some((body) => body.includes('"tools"')),
      history: [
        bodies[0]?.includes("I close the month.") === true,
        bodies[1]?.includes("What do you do most weeks?") === true,
      ],
      audited: events.map(({ action, actor }) => [action, actor.type]),
    }).toStrictEqual({
      link: "/guest",
      secret: 43,
      opened: {
        name: "Anna",
        status: "open",
        turnsLeft: guestTurnsMax,
        messages: [],
      },
      again: 200,
      first: guestTurnsMax - 1,
      second: [
        expect.objectContaining({ role: "guest", text: "I close the month." }),
        expect.objectContaining({
          role: "agent",
          text: "What do you do most weeks?",
        }),
        expect.objectContaining({ role: "guest", text: "Three days." }),
        expect.objectContaining({
          role: "agent",
          text: "How long does that take?",
        }),
      ],
      read: [
        expect.objectContaining({ role: "guest", text: "I close the month." }),
        expect.objectContaining({ role: "agent" }),
        expect.objectContaining({ role: "guest", text: "Three days." }),
        expect.objectContaining({ role: "agent" }),
      ],
      guide: true,
      bounds: true,
      tools: false,
      history: [true, true],
      // Opened once however often it opens; each turn by the guest, each
      // model call as the guest, reading back by the App.
      audited: [
        ["guest.invited", "app"],
        ["guest.opened", "guest"],
        ["model.call", "guest"],
        ["guest.message", "guest"],
        ["model.call", "guest"],
        ["guest.message", "guest"],
        ["guest.read", "app"],
      ],
    });
  });

  it("open nothing with a made-up, malformed or unshaped secret, and never another App's chat", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const { app: other } = await guestApp(builder);
    const { id } = await invite(app, builder.userId);
    const madeUp = "A".repeat(43);
    const got = await routed("/api/guest");
    // A body streamed without a length: read no further than the bound.
    const streamed = await routed("/api/guest", {
      method: "POST",
      body: new Blob(["x".repeat(20_000)]).stream(),
    });
    const streamedBody: unknown = await streamed.json();
    expect({
      madeUp: codeOf(await guest({ action: "open", token: madeUp })),
      short: codeOf(await guest({ action: "open", token: "abc" })),
      unknownAction: codeOf(await guest({ action: "read", token: madeUp })),
      notJson: codeOf(await guest("{")),
      tooLarge: codeOf(
        await guest({ action: "send", token: madeUp, text: "x".repeat(20_000) })
      ),
      get: got.status,
      streamed: codeOf({ status: streamed.status, body: streamedBody }),
      otherApp: await call(other, builder.userId, "read", { id }),
      otherRevoke: await call(other, builder.userId, "revoke", { id }),
    }).toStrictEqual({
      madeUp: { status: 404, code: "guest.link_invalid" },
      short: { status: 400, code: "guest.invalid" },
      unknownAction: { status: 400, code: "guest.invalid" },
      notJson: { status: 400, code: "guest.invalid" },
      tooLarge: { status: 400, code: "guest.invalid" },
      streamed: { status: 400, code: "guest.invalid" },
      get: 405,
      otherApp: { error: "permission.item_not_found" },
      otherRevoke: { error: "permission.item_not_found" },
    });
  });

  it("stop a link once it expires, is revoked or finished, or its App's permission, its member, their use of the App or the feature is gone", async () => {
    const builder = await signedInApi(idp, "builder");
    const admin = await signedInApi(idp, "admin");
    const user = await signedInApi(idp, "user");
    const { app, permission } = await guestApp(builder);
    const revoked = await invite(app, builder.userId);
    const revokedChat = await call(app, builder.userId, "revoke", {
      id: revoked.id,
    });
    const afterRevoke = {
      chat: z
        .object({ ok: z.object({ status: z.string() }) })
        .parse(revokedChat).ok.status,
      // Nothing opens, what was written neither.
      open: codeOf(await guest({ action: "open", token: revoked.token })),
      send: codeOf(await guest(send(revoked.token))),
      finish: codeOf(await guest({ action: "finish", token: revoked.token })),
    };
    const finished = await invite(app, builder.userId);
    const finishing = await guest({ action: "finish", token: finished.token });
    const afterFinish = {
      answer: viewOf(finishing).status,
      send: codeOf(await guest(send(finished.token))),
      again: codeOf(await guest({ action: "finish", token: finished.token })),
      // Finished, it still shows what was written, until it is revoked.
      open: viewOf(await guest({ action: "open", token: finished.token }))
        .status,
      revoked: z
        .object({ ok: z.object({ status: z.string() }) })
        .parse(await call(app, builder.userId, "revoke", { id: finished.id }))
        .ok.status,
      afterRevoke: codeOf(
        await guest({ action: "open", token: finished.token })
      ),
    };

    const expiring = await invite(app, builder.userId, { days: 1 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 1000);
    const expired = {
      open: viewOf(await guest({ action: "open", token: expiring.token }))
        .status,
      send: codeOf(await guest(send(expiring.token))),
    };
    vi.useRealTimers();

    const memberGone = await invite(app, builder.userId);
    const rejoin = await leave(builder.userId);
    const whileGone = codeOf(
      await guest({ action: "open", token: memberGone.token })
    );
    await rejoin();
    const reopened = await guest({ action: "open", token: memberGone.token });
    const back = reopened.status;

    // Someone the App is shared with invites; unshared, their link is gone.
    const member = { type: "person", id: user.userId } as const;
    await builder.api.apps.members.add(app, { ...member, role: "user" });
    const unshared = await invite(app, user.userId);
    const sharedOpen = await guest({ action: "open", token: unshared.token });
    const whileShared = sharedOpen.status;
    await builder.api.apps.members.remove(app, member);
    const afterUnshared = codeOf(
      await guest({ action: "open", token: unshared.token })
    );

    const permissionGone = await invite(app, builder.userId);
    await admin.api.permissions.revoke(permission);

    expect({
      revoked: afterRevoke,
      finished: afterFinish,
      expired,
      whileGone,
      back,
      whileShared,
      afterUnshared,
      permissionGone: codeOf(
        await guest({ action: "open", token: permissionGone.token })
      ),
      // And the App no longer invites or reads.
      appAfter: await call(app, builder.userId, "list"),
    }).toStrictEqual({
      revoked: {
        chat: "revoked",
        open: { status: 404, code: "guest.link_invalid" },
        send: { status: 404, code: "guest.link_invalid" },
        finish: { status: 404, code: "guest.link_invalid" },
      },
      finished: {
        answer: "finished",
        send: { status: 410, code: "guest.ended" },
        again: { status: 410, code: "guest.ended" },
        open: "finished",
        revoked: "revoked",
        afterRevoke: { status: 404, code: "guest.link_invalid" },
      },
      expired: { open: "expired", send: { status: 410, code: "guest.ended" } },
      whileGone: { status: 404, code: "guest.link_invalid" },
      back: 200,
      whileShared: 200,
      afterUnshared: { status: 404, code: "guest.link_invalid" },
      permissionGone: { status: 404, code: "guest.link_invalid" },
      appAfter: { error: "permission.unavailable" },
    });
  });

  it("take one message at a time, and none once the chat ended under it", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const { id, token } = await invite(app, builder.userId);

    // The first message's model call waits until the second has been
    // refused, and the guest has finished the chat.
    const gate = Promise.withResolvers<null>();
    const provider = await answeringProvider(async () => {
      await gate.promise;
      return reply("Question 1");
    });
    const sending = guest({ action: "send", token, text: "First" });
    await vi.waitFor(
      () => {
        expect(provider.requests.length).toBeGreaterThan(0);
      },
      { timeout: 10_000, interval: 20 }
    );
    const busy = codeOf(await guest({ action: "send", token, text: "Second" }));
    const finished = viewOf(await guest({ action: "finish", token }));
    gate.resolve(null);
    const first = await sending;
    const after = viewOf(await guest({ action: "open", token }));
    const logged = await allEvents();
    expect({
      busy,
      finished: finished.status,
      // The turn ran, and landed nothing: the chat had ended.
      first: viewOf(first).messages,
      after: after.messages,
      audited: logged
        .filter(({ target }) => target?.id === id)
        .map(({ action }) => action),
    }).toStrictEqual({
      busy: { status: 429, code: "guest.busy" },
      finished: "finished",
      first: [],
      after: [],
      audited: ["guest.invited", "guest.finished", "guest.opened"],
    });
  });

  it("make at most 20 model calls a chat, failed ones too, of at most 1,000 characters", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const { token } = await invite(app, builder.userId);
    // Refused by the provider, as the gateway may bill: never asked again.
    const refusals = Array.from({ length: guestTurnsMax + 1 }, () => ({
      status: 400,
      errorType: "invalid_request_error",
    }));
    const { sent, calls } = await answering(refusals, async (provider) => {
      const answers: { status: number; code: string }[] = [];
      for (let turn = 0; turn <= guestTurnsMax; turn += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one turn at a time
        answers.push(codeOf(await guest(send(token))));
      }
      return { sent: answers, calls: provider.requests.length };
    });
    const after = viewOf(await guest({ action: "open", token }));
    expect({
      failed: sent
        .slice(0, guestTurnsMax)
        .every(({ code }) => code === "guest.unavailable"),
      last: sent.at(-1),
      calls,
      after: { turnsLeft: after.turnsLeft, messages: after.messages.length },
      tooLong: codeOf(
        await guest({ action: "send", token, text: "x".repeat(1001) })
      ),
    }).toStrictEqual({
      failed: true,
      last: { status: 409, code: "guest.no_turns_left" },
      calls: guestTurnsMax,
      after: { turnsLeft: 0, messages: 0 },
      tooLong: { status: 400, code: "guest.invalid" },
    });
  });

  it("show nothing of a chat revoked after its link was checked, before what was written is read", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const { id, token } = await invite(app, builder.userId);
    await answering([reply("What do you do?")], async () => {
      await guest({ action: "open", token });
      await guest({ action: "send", token, text: "I close the month." });
    });
    // The open's read of the messages waits until the chat is revoked.
    const real = env.DB;
    const held = Promise.withResolvers<null>();
    const resume = Promise.withResolvers<null>();
    let reads = false;
    let holding = true;
    env.DB = new Proxy(real, {
      get: (target, key) => {
        if (key === "prepare") {
          return (query: string) => {
            reads ||= readsMessages.test(query);
            return target.prepare(query);
          };
        }
        if (key === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (reads && holding) {
              holding = false;
              held.resolve(null);
              await resume.promise;
            }
            return await target.batch(statements);
          };
        }
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") {
          return value;
        }
        const bound: unknown = value.bind(target);
        return bound;
      },
    });
    let opened: { status: number; body: unknown };
    let revoked: unknown;
    try {
      const opening = guest({ action: "open", token });
      await held.promise;
      revoked = await call(app, builder.userId, "revoke", { id });
      resume.resolve(null);
      opened = await opening;
    } finally {
      resume.resolve(null);
      env.DB = real;
    }
    expect({
      revoked: z.object({ ok: z.object({ status: z.string() }) }).parse(revoked)
        .ok.status,
      opened: codeOf(opened),
      // Nothing of what was written is in the answer.
      leaked: JSON.stringify(opened.body).includes("I close the month."),
    }).toStrictEqual({
      revoked: "revoked",
      opened: { status: 404, code: "guest.link_invalid" },
      leaked: false,
    });
  });
});

describe("guest chats through a binding", { timeout: 90_000 }, () => {
  beforeEach(connected);

  it("reach nothing until an admin binds them to the App's own permission, nothing more than was approved, and no link past the binding", async () => {
    const builder = await signedInApi(idp, "builder");
    const admin = await signedInApi(idp, "admin");
    // Listing and reading only, as version 1 declares it.
    const { id } = await builder.api.apps.create({
      name: `Guests ${unique()}`,
    });
    const app = appIdSchema.parse(id);
    await release(builder, app, guestFiles('["list", "read"]'));
    const unbound = await call(app, builder.userId, "list");
    const permission = await grantGuests(builder, app);
    // Another App's permission serves this one nothing, nor one of its own
    // to do something else.
    const { permission: theirs } = await guestApp(builder);
    const othersGrant = await failure(
      async () => await bindGuests(app, theirs)
    );
    const statistics = await requestGranted(idp, builder, {
      subject: { type: "app", appId: app },
      object: { type: "platform" },
      actions: ["statistics"],
      binding: "STATS",
    });
    const otherAction = await failure(
      async () => await bindGuests(app, statistics)
    );
    await bindGuests(app, permission);
    const bound = await call(app, builder.userId, "list");
    // Version 2 invites too: what was approved serves it no more. (Its
    // permission, which changes things, is asked for again with it, and
    // an admin grants it again.)
    await release(builder, app, guestFiles());
    await grantReviewed(admin.api, permission);
    const widened = await call(app, builder.userId, "list");
    const binding = await bindGuests(app, permission);
    const { token } = await invite(app, builder.userId);
    const firstOpen = await guest({ action: "open", token });
    const opened = firstOpen.status;
    // The binding revoked: the App reaches nothing, and the link opens
    // nothing, though the permission still holds.
    await admin.api.resourceBindings.revoke(binding.id);
    const afterRevoke = {
      app: await call(app, builder.userId, "list"),
      link: codeOf(await guest({ action: "open", token })),
    };
    // Bound again to the same permission: the link opens again.
    await bindGuests(app, permission);
    const reopened = await guest({ action: "open", token });
    const rebound = reopened.status;
    // Bound to another of the App's permissions: not this link's.
    const another = await grantGuests(builder, app, "MORE_GUESTS");
    await bindGuests(app, another);
    const otherPermission = codeOf(await guest({ action: "open", token }));
    expect({
      unbound,
      othersGrant,
      otherAction,
      bound,
      widened,
      opened,
      afterRevoke,
      rebound,
      otherPermission,
    }).toStrictEqual({
      unbound: { error: "permission.unavailable" },
      othersGrant: "permission.target_invalid",
      otherAction: "permission.target_invalid",
      bound: { ok: [] },
      widened: { error: "permission.unavailable" },
      opened: 200,
      afterRevoke: {
        app: { error: "permission.unavailable" },
        link: { status: 404, code: "guest.link_invalid" },
      },
      rebound: 200,
      otherPermission: { status: 404, code: "guest.link_invalid" },
    });
  });

  it("invite no one from an App that may hold what the Brain recalled: a guest is outside the company", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const before = await invite(app, builder.userId);
    // Then the App is granted the Brain, as an admin's grant writes it.
    await env.DB.prepare(
      `INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id,
        actions, binding, status, requested_by, requested_at, granted_by, granted_at)
       VALUES (?, 'app', ?, 'platform', 'platform', '["brain"]', ?, 'active', 'test', 0, 'test', 0)`
    )
      .bind(
        crypto.randomUUID(),
        app,
        `BRAIN_${unique().replaceAll(/\W/gu, "_").toUpperCase()}`
      )
      .run();
    expect({
      before: before.link.length > 0,
      after: await ask(app, builder.userId),
    }).toStrictEqual({
      before: true,
      after: { error: "permission.not_allowed" },
    });
  });
});
