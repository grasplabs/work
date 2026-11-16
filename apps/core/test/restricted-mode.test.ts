import {
  appIdSchema,
  chatIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type {
  PermissionRequest,
  PermissionSubjectInput,
} from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { appHost, workspace } from "../src/durable-objects.ts";
import { isRestricted, restrict } from "../src/restricted.ts";
import type { WorkContext } from "../src/restricted.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import {
  actingFor,
  connectionIn,
  envOf,
  newChat,
  reached,
} from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";
import { storedGrant } from "./stored-grants.ts";

// Restricted mode: a chat or App that read restricted data (an App's
// restricted answer, say: agent-apps.ts, workflows/app-calls.ts) still
// acts in outside systems only as the person confirms it, with a warning,
// also after its object restarts (Q12). These tests start from the ways it
// can fail: someone else's code keeps or reads another's restricted mode;
// it is kept where nothing can be held to it; it is set without its
// record; or it ends with a restart.

const idp = mockIdp();

/**
 * Each test signs people in and has permissions granted before it acts,
 * which on a loaded CI runner can take as long as Vitest's default 5
 * seconds per test.
 */
const setUpTime = { timeout: 60_000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personOf = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

const newAgent = () => ({
  type: "agent" as const,
  agentId: `agent-${unique()}`,
});

const outlook = (subject: PermissionSubjectInput): PermissionRequest => ({
  subject,
  object: { type: "connection", connectionId: "connection-outlook" },
  actions: ["mail.list", "mail.send"],
  binding: "OUTLOOK",
});

type Env = Awaited<ReturnType<typeof envOf>>;

/** A fetch from Outlook, from an env. */
const callOutlook = async (bindings: Env) => {
  const stub = connectionIn(bindings, "OUTLOOK");
  if (!stub) {
    throw new Error("No OUTLOOK binding");
  }
  return await outcome(stub.call("mail.list", {}));
};

/** A side effect, a mail sent, from an env. */
const sendMail = async (bindings: Env) => {
  const stub = connectionIn(bindings, "MAIL");
  if (!stub) {
    throw new Error("No MAIL binding");
  }
  return await outcome(
    stub.call(
      "mail.send",
      { to: "x@elsewhere.test", subject: "Payroll" },
      { idempotencyKey: unique() }
    )
  );
};

/**
 * Whether each action held for `person` from `chat` comes with the
 * restricted-data warning.
 */
const warningsIn = async (
  person: Person,
  chat: Extract<WorkContext, { type: "chat" }>
): Promise<boolean[]> => {
  const waiting = await person.api.pendingActions.list();
  return waiting
    .filter(
      ({ context }) => context.type === "chat" && context.chatId === chat.chatId
    )
    .map(({ restricted }) => restricted);
};

/** A side effect from chat: held for the person to confirm. */
const heldWrite = "ok";

/** What put a chat or App in restricted mode: a restricted source it read. */
const payroll = "app-read:payroll";

/** `subject`, granted Outlook and sending mail on a mail connection of its own. */
const setUp = async (subject: PermissionSubjectInput = newAgent()) => {
  const admin = await personOf("admin");
  await requestGranted(idp, admin, outlook(subject));
  const mail = await mailConnection();
  await requestGranted(idp, admin, {
    subject,
    object: { type: "connection", connectionId: mail.id },
    actions: ["mail.send"],
    binding: "MAIL",
  });
  return { admin, subject, mail };
};

/** A new App of `creator`'s, by its ID. */
const newApp = async (creator: Person) => {
  const { id } = await creator.api.apps.create({ name: `App ${unique()}` });
  return appIdSchema.parse(id);
};

describe("restricted mode", setUpTime, () => {
  it("is kept only by the agent of the chat's own workspace", async () => {
    const admin = await personOf("admin");
    const agent = newAgent();
    const chat = await newChat(agent);
    const app = await admin.api.apps.create({ name: `App ${unique()}` });
    const strangers = [
      actingFor(newAgent(), admin.userId),
      actingFor({ type: "app", appId: app.id }, admin.userId),
    ];

    const tried = await Promise.all(
      strangers.flatMap((stranger) => [
        outcome(isRestricted(env, stranger, chat)),
        outcome(restrict(env, stranger, chat, [payroll])),
      ])
    );

    expect({
      tried,
      own: await isRestricted(env, actingFor(agent, admin.userId), chat),
    }).toStrictEqual({
      tried: Array.from({ length: 4 }, () => "permission.context_invalid"),
      // Nobody else put it in restricted mode.
      own: false,
    });
  });

  it("holds a chat's actions with a restricted-data warning for good once it read restricted data", async () => {
    const { admin, subject, mail } = await setUp();
    const chat = await newChat(subject);
    const otherChat = await newChat(subject);
    const acting = actingFor(subject, admin.userId);
    const bindings = await envOf(acting, chat);

    const beforeRestricted = await Promise.all([
      callOutlook(bindings),
      sendMail(bindings),
    ]);
    await restrict(env, acting, chat, [payroll]);
    const afterRestricted = await Promise.all([
      // A fetch still reaches connect, which lets declared reads through.
      callOutlook(bindings),
      sendMail(bindings),
    ]);
    expect({ beforeRestricted, afterRestricted }).toStrictEqual({
      beforeRestricted: [reached, heldWrite],
      // Held for the person like any.
      afterRestricted: [reached, heldWrite],
    });

    // Its workspace restarts, and the chat gets a new env: still restricted.
    await evictDurableObject(workspace(env, chat.workspaceId));
    const rebuilt = await envOf(acting, chat);
    const other = await envOf(acting, otherChat);
    const restarted = await Promise.all([
      callOutlook(rebuilt),
      sendMail(rebuilt),
    ]);
    // Another chat is its own: it read nothing restricted.
    const otherChatSent = await sendMail(other);
    expect({
      restarted,
      otherChat: otherChatSent,
      warned: await warningsIn(admin, chat),
      otherWarned: await warningsIn(admin, otherChat),
      server: await mail.did(),
    }).toStrictEqual({
      restarted: [reached, heldWrite],
      otherChat: heldWrite,
      // Every action it holds warns, the one before too: the chat holds
      // restricted data now, whatever it acts on.
      warned: [true, true, true],
      otherWarned: [false],
      server: { calls: 0, sent: [] },
    });
  });

  it("holds an App's actions with a restricted-data warning for good once it read restricted data", async () => {
    const appId = await newApp(await personOf("admin"));
    const { admin, subject } = await setUp({ type: "app", appId });
    const context: WorkContext = { type: "app", appId };
    const acting = actingFor(subject, admin.userId);
    const bindings = await envOf(acting, context);

    const before = await sendMail(bindings);
    await restrict(env, acting, context, [payroll]);
    await evictDurableObject(appHost(env, appId));
    const after = await sendMail(await envOf(acting, context));
    const waiting = await admin.api.pendingActions.list();
    expect({
      before,
      after,
      warned: waiting
        .filter(
          (held) => held.context.type === "app" && held.context.appId === appId
        )
        .map(({ restricted }) => restricted),
    }).toStrictEqual({
      before: heldWrite,
      after: heldWrite,
      warned: [true, true],
    });
  });

  it("is audited once, when a chat or an App enters it, with what put it there", async () => {
    const admin = await personOf("admin");
    const appId = await newApp(admin);
    const app = { type: "app" as const, appId };
    const agent = newAgent();
    const chat = await newChat(agent);
    // The first restricted read restricts; the second finds it restricted
    // already.
    for (const [who, where] of [
      [agent, chat],
      [app, app],
    ] as const) {
      for (const source of [payroll, "app-read:salaries"]) {
        // oxlint-disable-next-line no-await-in-loop -- one read at a time, in order
        await restrict(env, actingFor(who, admin.userId), where, [source]);
      }
    }
    // Entering restricted mode is recorded before it is set (the next
    // test). `allEvents` drains the outboxes before it reads.
    const logged = await allEvents();
    const audited = logged.filter(
      ({ action, target }) =>
        action === "context.restricted" &&
        (target?.id === chat.chatId || target?.id === appId)
    );
    expect(
      audited.map(({ actor, target, provenance, detail }) => ({
        actor,
        target,
        provenance,
        detail,
      }))
    ).toStrictEqual([
      {
        actor: {
          type: "agent",
          agentId: agent.agentId,
          onBehalfOf: admin.userId,
        },
        target: { type: "chat", id: chat.chatId },
        provenance: [payroll],
        detail: { workspace: chat.workspaceId },
      },
      {
        actor: { type: "app", appId, part: "server" },
        target: { type: "app", id: appId },
        provenance: [payroll],
        detail: {},
      },
    ]);
  });

  it("records entering restricted mode before setting it, so a failed record restricts nothing", async () => {
    const admin = await personOf("admin");
    const appId = await newApp(admin);
    const app = { type: "app" as const, appId };
    const acting = actingFor(app, admin.userId);
    // Core's outbox refuses every event, as a failing database would.
    await env.DB.prepare(
      "CREATE TRIGGER outbox_unavailable BEFORE INSERT ON audit_outbox BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END"
    ).run();
    let failed: unknown;
    let restrictedAfterFailure: boolean;
    try {
      failed = await restrict(env, acting, app, [payroll]).then(
        () => "restricted",
        () => "refused"
      );
      restrictedAfterFailure = await appHost(env, appId).isRestricted();
    } finally {
      await env.DB.prepare("DROP TRIGGER outbox_unavailable").run();
    }
    // The next restricted read records it, and restricts.
    await restrict(env, acting, app, [payroll]);
    const logged = await allEvents();
    const events = logged.filter(
      ({ action, target }) =>
        action === "context.restricted" && target?.id === appId
    );
    expect({
      failed,
      restrictedAfterFailure,
      restrictedNow: await appHost(env, appId).isRestricted(),
      events: events.length,
    }).toStrictEqual({
      failed: "refused",
      restrictedAfterFailure: false,
      restrictedNow: true,
      events: 1,
    });
  });

  it("is kept only in a context that exists and is the App's own", async () => {
    const { admin, subject } = await setUp();
    const creator = await personOf("admin");
    const [own, other] = await Promise.all([newApp(creator), newApp(creator)]);
    const app = { type: "app" as const, appId: own };
    await requestGranted(idp, admin, outlook(app));
    const ghost = `app-${unique()}`;
    await storedGrant(
      { type: "app", id: ghost },
      { type: "connection", id: "connection-outlook" },
      ["mail.list"],
      "OUTLOOK"
    );

    const refusedIn = async (
      who: PermissionSubjectInput,
      context: WorkContext,
      read: boolean
    ) => {
      const acting = actingFor(who, admin.userId);
      const bindings = await envOf(acting, context);
      return [
        await callOutlook(bindings),
        read
          ? await outcome(restrict(env, acting, context, [payroll]))
          : "no read",
      ];
    };
    // Nowhere to keep restricted mode, or someone else's: nothing that would
    // need it runs.
    expect({
      missingChat: await refusedIn(
        subject,
        {
          type: "chat",
          workspaceId: workspaceIdSchema.parse(crypto.randomUUID()),
          chatId: chatIdSchema.parse(crypto.randomUUID()),
        },
        true
      ),
      agentInApp: await refusedIn(subject, { type: "app", appId: own }, true),
      otherApp: await refusedIn(app, { type: "app", appId: other }, true),
      unknownApp: await refusedIn(
        { type: "app", appId: ghost },
        { type: "app", appId: appIdSchema.parse(ghost) },
        false
      ),
    }).toStrictEqual({
      missingChat: ["permission.context_invalid", "permission.context_invalid"],
      agentInApp: ["permission.context_invalid", "permission.context_invalid"],
      otherApp: ["permission.context_invalid", "permission.context_invalid"],
      unknownApp: ["permission.context_invalid", "no read"],
    });
    // Neither App was restricted by reads made in its name.
    await expect(
      Promise.all([
        appHost(env, own).isRestricted(),
        appHost(env, other).isRestricted(),
        callOutlook(
          await envOf(actingFor(app, admin.userId), { type: "app", appId: own })
        ),
      ])
    ).resolves.toStrictEqual([false, false, reached]);
  });
});
