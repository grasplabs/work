import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { guestTurnsMax } from "@grasp-os/shared/guests";
import type { GuestView } from "@grasp-os/shared/guests";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import { sweepGuestChats } from "../src/guests.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { grantReviewed, release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { endLiveRuns, finished as runFinished, leave } from "./runs.ts";
import { failure } from "./sealed-apps.ts";
import { outcome, routed, signedInApi, unique } from "./sign-in.ts";

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
// - An App inviting without bound or for someone else: from a workflow
//   run, with a skill the release doesn't have, more than 50 open.
// - Nothing on record: every step audited, as whom.
// - Kept forever: chats deleted 30 days after they end.

const idp = mockIdp();

/**
 * An App whose actions use its guest chats through `guests`, declaring
 * `operations`: each answers what it got, or the error's code and
 * details, as JSON text.
 */
const guestFiles = (
  operations = '["invite", "list", "read", "revoke"]'
): Record<string, string> => ({
  "schema.ts": `import { defineSchema } from "@grasp-os/sdk";

export default defineSchema({});
`,
  "operations/guests.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const guests = resource.guests("guests", { operations: ${operations} });

const outcome = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    return JSON.stringify({ ok: (await run()) ?? null });
  } catch (error) {
    const details = Reflect.get(Object(error), "details");
    return JSON.stringify({
      error: String(Reflect.get(Object(error), "code") ?? "failed"),
      ...(details === undefined ? {} : { details }),
    });
  }
};

export const invite = action({
  args: { json: v.string() },
  returns: v.string(),
  uses: [guests],
  handler: async (ctx, args) => await outcome(async () => await ctx.resources.guests.invite(JSON.parse(args.json))),
});

export const list = action({
  args: {},
  returns: v.string(),
  uses: [guests],
  handler: async (ctx) => await outcome(async () => await ctx.resources.guests.list()),
});

export const read = action({
  args: { id: v.string() },
  returns: v.string(),
  uses: [guests],
  handler: async (ctx, args) => await outcome(async () => await ctx.resources.guests.read(args.id)),
});

export const revoke = action({
  args: { id: v.string() },
  returns: v.string(),
  uses: [guests],
  handler: async (ctx, args) => await outcome(async () => await ctx.resources.guests.revoke(args.id)),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";

import { guests, invite, list, read, revoke } from "./operations/guests.ts";
import schema from "./schema.ts";

export default app({
  name: "Guests",
  schema,
  access: { tables: {} },
  operations: { guests: { invite, list, read, revoke } },
  internalOperations: {},
  screens: [],
  uses: [guests],
});
`,
});

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** The App's current version, as an admin reviews it. */
const currentVersion = async (app: string): Promise<number> => {
  const found = await env.DB.prepare(
    "SELECT current_version AS version FROM apps WHERE id = ?"
  )
    .bind(app)
    .first<{ version: number }>();
  return found?.version ?? 0;
};

/** An admin's binding of the App's `guests` to `permissionId`. */
const bindGuests = async (app: string, permissionId: string) => {
  const admin = await signedInApi(idp, "admin");
  return await admin.api.resourceBindings.approve({
    app,
    alias: "guests",
    target: { kind: "guests", permissionId },
    reviewed: { version: await currentVersion(app) },
  });
};

/** The App's permission to invite guests, asked for by `builder` and granted. */
const grantGuests = async (
  builder: Person,
  app: string,
  binding = "GUESTS"
): Promise<string> =>
  await requestGranted(idp, builder, {
    subject: { type: "app", appId: app },
    object: { type: "platform" },
    actions: ["guests"],
    binding,
  });

/**
 * An App that may invite guests, with `files`: its permission granted by
 * an admin, and its `guests` resource bound to it.
 */
const guestApp = async (
  builder: Person,
  files = guestFiles()
): Promise<{ app: AppId; permission: string }> => {
  const { id } = await builder.api.apps.create({ name: `Guests ${unique()}` });
  await release(builder, id, files);
  const permission = await grantGuests(builder, id);
  await bindGuests(id, permission);
  return { app: appIdSchema.parse(id), permission };
};

/** Who `userId` is to a call: their ID, role and teams. */
const callerOf = async (userId: string) => {
  const member = await env.DB.prepare(
    "SELECT role FROM members WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ role: "admin" | "builder" | "user" }>();
  return { userId, role: member?.role ?? "user", teams: [] };
};

/**
 * Calls `guests.<method>` of `app`'s current release as `userId`, with
 * `input`, as a screen would: what the action answered, read back, or the
 * call's own refusal.
 */
const call = async (
  app: AppId,
  userId: string,
  method: string,
  input: Record<string, unknown> = {}
): Promise<unknown> => {
  const path = `guests.${method}`;
  const sealed = await loadRelease(env, app, await currentVersion(app));
  const operation = sealed.app.operations[path];
  if (operation === undefined) {
    throw new Error(`No ${path}`);
  }
  const { result } = await callAppFunction(
    env,
    await callerOf(userId),
    app,
    JSON.stringify({
      reference: {
        resourceId: sealed.manifest.resourceId,
        resourceVersion: sealed.manifest.resourceVersion,
        contractId: path,
        fingerprint: sealed.fingerprints[path] ?? "",
        kind: operation.kind,
      },
      input,
    })
  );
  if (result.ok && typeof result.value === "string") {
    const parsed: unknown = JSON.parse(result.value);
    return parsed;
  }
  return { refused: result.ok ? result.value : result.error.code };
};

/** Asks `app` to invite a guest, as `userId`, with `input` on the defaults. */
const ask = async (
  app: AppId,
  userId: string,
  input: Record<string, unknown> = {}
) =>
  await call(app, userId, "invite", {
    json: JSON.stringify({
      name: "Anna",
      skill: "interview-a-stakeholder",
      ...input,
    }),
  });

const invitedSchema = z.object({
  ok: z.object({ id: z.string(), link: z.string(), status: z.string() }),
});

/** Invites a guest in `app` for `userId`: the chat's ID and link secret. */
const invite = async (
  app: AppId,
  userId: string,
  input: Record<string, unknown> = {}
): Promise<{ id: string; token: string; link: string }> => {
  const { ok } = invitedSchema.parse(await ask(app, userId, input));
  return { id: ok.id, token: new URL(ok.link).hash.slice(1), link: ok.link };
};

/** What the guest's page sends, and what core answers. */
const guest = async (
  body: unknown,
  init: RequestInit = {},
  coreEnv: Env = env
): Promise<{ status: number; body: unknown }> => {
  const response = await routed(
    "/api/guest",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    },
    coreEnv
  );
  return { status: response.status, body: await response.json() };
};

const viewSchema = z.object({
  name: z.string(),
  status: z.string(),
  turnsLeft: z.number(),
  messages: z.array(z.object({ role: z.string(), text: z.string() })),
});

const viewOf = (answer: { body: unknown }): GuestView =>
  // SAFETY: checked by the schema; the rest is as core answers it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  viewSchema.parse(answer.body) as GuestView;

const codeOf = ({ status, body }: { status: number; body: unknown }) => ({
  status,
  code: z.object({ code: z.string() }).parse(body).code,
});

/** A plan's step over rows the query itself gives: no table's. */
const literalRows = /^SCAN (?:\d+-ROW VALUES CLAUSE|CONSTANT ROW)$/u;

/** Core's read of a chat's messages. */
const readsMessages = /^select .* from "guest_messages"/iu;

/** A guest's message, "Hello", with the secret `token`. */
const send = (token: string) => ({ action: "send", token, text: "Hello" });

/** The model answers with `replies`, in order, while `run` runs. */
const answering = async <T>(
  replies: GatewayReply[],
  run: (gateway: ReturnType<typeof fakeGateway>) => Promise<T>
): Promise<T> => {
  const gateway = fakeGateway(...replies);
  const ai: AiBinding = env.AI;
  const spy = vi.spyOn(ai, "fetch").mockImplementation(gateway.binding.fetch);
  try {
    return await run(gateway);
  } finally {
    spy.mockRestore();
  }
};

const reply = (text: string): GatewayReply => ({
  text,
  inputTokens: 50,
  outputTokens: 10,
});

describe("guest chats", { timeout: 60_000 }, () => {
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
      async (gateway) => ({
        first: await guest({
          action: "send",
          token,
          text: "I close the month.",
        }),
        second: await guest({ action: "send", token, text: "  Three days.  " }),
        requests: gateway.requests,
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
      otherApp: { error: "resource.item_not_found" },
      otherRevoke: { error: "resource.item_not_found" },
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
      appAfter: { error: "resource.unavailable" },
    });
  });

  it("take one message at a time, and none once the chat ended under it", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const { id, token } = await invite(app, builder.userId);

    // The first message's model call waits until the second has been
    // refused, and the guest has finished the chat.
    const gate = Promise.withResolvers<null>();
    const gateway = fakeGateway(reply("Question 1"));
    const ai: AiBinding = env.AI;
    const spy = vi.spyOn(ai, "fetch").mockImplementation(async (...args) => {
      await gate.promise;
      return await gateway.binding.fetch(...args);
    });
    let busy: { status: number; code: string };
    let finished: GuestView;
    let first: { status: number; body: unknown };
    try {
      const sending = guest({ action: "send", token, text: "First" });
      await vi.waitFor(
        () => {
          expect(spy.mock.calls.length).toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 20 }
      );
      busy = codeOf(await guest({ action: "send", token, text: "Second" }));
      finished = viewOf(await guest({ action: "finish", token }));
      gate.resolve(null);
      first = await sending;
    } finally {
      spy.mockRestore();
    }
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
    const { sent, calls } = await answering(refusals, async (gateway) => {
      const answers: { status: number; code: string }[] = [];
      for (let turn = 0; turn <= guestTurnsMax; turn += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one turn at a time
        answers.push(codeOf(await guest(send(token))));
      }
      return { sent: answers, calls: gateway.requests.length };
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
    // tests left more than that: the cron's next runs take the rest.
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

/** A function of the Guests App, as a step names it. */
const reference = (name: string) =>
  JSON.stringify({ contractId: `guests.${name}`, kind: "action" });

/** What a function's answer, as a step got it, holds: the action's own. */
const answerOf = (answer: unknown): unknown => {
  const parsed = z
    .object({ ok: z.literal(true), value: z.string() })
    .safeParse(answer);
  if (!parsed.success) {
    return answer;
  }
  const value: unknown = JSON.parse(parsed.data.value);
  return value;
};

describe("guest chats through a binding", { timeout: 90_000 }, () => {
  afterEach(async () => {
    await endLiveRuns();
  });

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
    // Another App's permission serves this one nothing.
    const { permission: theirs } = await guestApp(builder);
    const othersGrant = await failure(
      async () => await bindGuests(app, theirs)
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
      bound,
      widened,
      opened,
      afterRevoke,
      rebound,
      otherPermission,
    }).toStrictEqual({
      unbound: { error: "resource.unavailable" },
      othersGrant: "resource.target_invalid",
      bound: { ok: [] },
      widened: { error: "resource.unavailable" },
      opened: 200,
      afterRevoke: {
        app: { error: "resource.unavailable" },
        link: { status: 404, code: "guest.link_invalid" },
      },
      rebound: 200,
      otherPermission: { status: 404, code: "guest.link_invalid" },
    });
  });

  it("are never invited by a workflow run, which may still list and revoke them, audited as the run", async () => {
    const builder = await signedInApi(idp, "builder");
    const inviteInput = JSON.stringify({
      json: JSON.stringify({ name: "Anna", skill: "interview-a-stakeholder" }),
    });
    const { app } = await guestApp(builder, {
      ...guestFiles(),
      "workflows/inviter.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("inviter", { params: {}, input: z.object({ chat: z.string() }) }, async (step, { env, input }) =>
  await step.do("ask", { description: "Invite", sideEffect: true, input: null, retries: { limit: 0 } }, async () => ({
    invited: await env.APP.callFunction(${reference("invite")}, ${inviteInput}),
    listed: await env.APP.callFunction(${reference("list")}, {}),
    revoked: await env.APP.callFunction(${reference("revoke")}, { id: input.chat }),
  }))
);
`,
      "workflows/inviter.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./inviter.ts";

export default workflowTests(definition, [{ name: "runs", input: { chat: "chat" }, mocks: { ask: null }, expect: {} }]);
`,
    });
    const chat = await invite(app, builder.userId);
    const run = await builder.api.workflows.start(app, "inviter", {
      chat: chat.id,
    });
    await runFinished(run.id);
    const ended = await builder.api.workflows.status(run.id);
    const logged = await allEvents();
    const output = z
      .object({
        invited: z.unknown(),
        listed: z.unknown(),
        revoked: z.unknown(),
      })
      .parse(ended.output);
    const chats = z
      .object({ ok: z.array(z.object({ id: z.string(), status: z.string() })) })
      .safeParse(answerOf(output.listed));
    const revoked = z
      .object({ ok: z.object({ status: z.string() }) })
      .safeParse(answerOf(output.revoked));
    expect({
      status: ended.status,
      invited: answerOf(output.invited),
      listed: chats.data?.ok.map(({ id }) => id),
      revoked: revoked.data?.ok.status,
      audited: logged
        .filter(
          ({ action, target }) =>
            action === "guest.revoked" && target?.id === chat.id
        )
        .map(({ actor, detail }) => ({ actor, onBehalfOf: detail.onBehalfOf })),
    }).toStrictEqual({
      status: "completed",
      invited: { error: "resource.not_allowed" },
      // Only the chat its person invited: the run made none.
      listed: [chat.id],
      revoked: "revoked",
      audited: [
        {
          actor: {
            type: "workflow",
            appId: app,
            workflowId: "inviter",
            runId: run.id,
          },
          onBehalfOf: builder.userId,
        },
      ],
    });
  });
});
