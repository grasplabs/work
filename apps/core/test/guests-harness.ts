import type { GuestView } from "@grasp-os/shared/guests";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import { testApp } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { release, requestGranted } from "./apps.ts";
import { createIdp } from "./fake-idp.ts";
import { fakeProvider } from "./model-provider.ts";
import type { FakeProvider, ProviderReply } from "./model-provider.ts";
import { routed, signedInApi, unique } from "./sign-in.ts";

// What guests*.test.ts share: the IdP, the App guests chat with, and how
// they invite and talk as a guest. Each file has the IdP answer for its
// own tests (`mockIdpWith`).

export const idp = createIdp();

/**
 * An App whose actions use its guest chats through `guests`, declaring
 * `operations`: each answers what it got, or the error's code and
 * details, as JSON text.
 */
export const guestFiles = (
  operations = '["invite", "list", "read", "revoke"]'
): TestApp =>
  testApp(
    {
      name: "Guests",
      tables: {},
      permissions: [`permission.guests({ operations: ${operations} })`],
    },
    {
      "server/guests.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const guests = permissions.guests;

// What the declaration may leave out, called past its types on purpose:
// the call is what refuses it.
const loose = (client: object) =>
  client as unknown as Record<string, (...input: unknown[]) => Promise<unknown>>;

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
  handler: async (ctx, args) => await outcome(async () => await loose(ctx.guests).invite(JSON.parse(args.json))),
});

export const list = action({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await outcome(async () => await loose(ctx.guests).list()),
});

export const read = action({
  args: { id: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => await outcome(async () => await loose(ctx.guests).read(args.id)),
});

export const revoke = action({
  args: { id: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => await outcome(async () => await loose(ctx.guests).revoke(args.id)),
});
`,
    }
  );

export type Person = Awaited<ReturnType<typeof signedInApi>>;

/** The App's current version, as an admin reviews it. */
export const currentVersion = async (app: string): Promise<number> => {
  const found = await env.DB.prepare(
    "SELECT current_version AS version FROM apps WHERE id = ?"
  )
    .bind(app)
    .first<{ version: number }>();
  return found?.version ?? 0;
};

/** An admin's binding of the App's `guests` to `permissionId`. */
export const bindGuests = async (app: string, permissionId: string) => {
  const admin = await signedInApi(idp, "admin");
  return await admin.api.resourceBindings.approve({
    app,
    alias: "guests",
    target: { kind: "guests", permissionId },
    reviewed: { version: await currentVersion(app) },
  });
};

/** The App's permission to invite guests, asked for by `builder` and granted. */
export const grantGuests = async (
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
export const guestApp = async (
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
export const callerOf = async (userId: string) => {
  const member = await env.DB.prepare(
    "SELECT role FROM members WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ role: "admin" | "builder" | "user" }>();
  return { userId, role: member?.role ?? "user", teams: [] };
};

/**
 * Calls `guests.<method>` of `app`'s current release as `userId`, with
 * `input`, as a page would: what the action answered, read back, or the
 * call's own refusal.
 */
export const call = async (
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
      reference: { name: path, kind: operation.kind },
      args: input,
    })
  );
  if (result.ok && typeof result.value === "string") {
    const parsed: unknown = JSON.parse(result.value);
    return parsed;
  }
  return { refused: result.ok ? result.value : result.error.code };
};

/** Asks `app` to invite a guest, as `userId`, with `input` on the defaults. */
export const ask = async (
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

export const invitedSchema = z.object({
  ok: z.object({ id: z.string(), link: z.string(), status: z.string() }),
});

/** Invites a guest in `app` for `userId`: the chat's ID and link secret. */
export const invite = async (
  app: AppId,
  userId: string,
  input: Record<string, unknown> = {}
): Promise<{ id: string; token: string; link: string }> => {
  const { ok } = invitedSchema.parse(await ask(app, userId, input));
  return { id: ok.id, token: new URL(ok.link).hash.slice(1), link: ok.link };
};

/** What the guest's page sends, and what core answers. */
export const guest = async (
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

export const viewSchema = z.object({
  name: z.string(),
  status: z.string(),
  turnsLeft: z.number(),
  messages: z.array(z.object({ role: z.string(), text: z.string() })),
});

export const viewOf = (answer: { body: unknown }): GuestView =>
  // SAFETY: checked by the schema; the rest is as core answers it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  viewSchema.parse(answer.body) as GuestView;

export const codeOf = ({
  status,
  body,
}: {
  status: number;
  body: unknown;
}) => ({
  status,
  code: z.object({ code: z.string() }).parse(body).code,
});

/** A plan's step over rows the query itself gives: no table's. */
export const literalRows = /^SCAN (?:\d+-ROW VALUES CLAUSE|CONSTANT ROW)$/u;

/** Core's read of a chat's messages. */
export const readsMessages = /^select .* from "guest_messages"/iu;

/** A guest's message, "Hello", with the secret `token`. */
export const send = (token: string) => ({
  action: "send",
  token,
  text: "Hello",
});

/** The model answers with `replies`, in order, while `run` runs. */
export const answering = async <T>(
  replies: ProviderReply[],
  run: (provider: FakeProvider) => Promise<T>
): Promise<T> => await run(await fakeProvider(...replies));

export const reply = (text: string): ProviderReply => ({
  text,
  inputTokens: 50,
  outputTokens: 10,
});

/**
 * The company connected an AI provider and chose its model, which a chat
 * is invited with; a test that has the model answer connects its own.
 */
export const connected = async (): Promise<void> => {
  await fakeProvider();
};
