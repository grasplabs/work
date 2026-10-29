import { routerHostKey } from "@grasp-os/shared/router";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { askGraspFn } from "../src/admin/ask-functions.ts";
import { adminDatabase } from "../src/db/act.ts";
import { auditEvents, clients } from "../src/db/schema.ts";
import {
  fetchPlatformSettings,
  setGraspClientFn,
} from "../src/platform-settings.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { callServerFn, page } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { emptyStoreSecret, useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-admin-ask-71c0d2";

const cloudflare = mockCloudflareApi(token);
mockAccess();

const db = adminDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** Before each test: only its own clients are read; an earlier test's accounts are gone from the fake. */
const eachTest = (): void => {
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
  });
};

/** An active client running a new release, as a deploy made it live, whose core answers an empty snapshot. */
const liveClient = async () => {
  const release = await placedRelease("feat(core): ask");
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const name = `Noordkade ${clientId}`;
  const { account } = await livePlacedClient(cloudflare, 1, release, {
    id: clientId,
    name,
    signIn: null,
  });
  account.admin = emptyAdminSnapshot("Noordkade");
  return { clientId, account };
};

/**
 * Runs `run` with `clientId` chosen as Grasp's own organization on
 * Platform, as staff choose it (undefined for none), its client domain as
 * `clientDomain` gives it, and without its dispatcher binding for
 * `noDispatcher`.
 */
const asGrasp = async <T>(
  clientId: string | undefined,
  run: () => Promise<T>,
  {
    clientDomain,
    noDispatcher = false,
  }: { clientDomain?: string; noDispatcher?: boolean } = {}
): Promise<T> => {
  const before = { ...env };
  const chosen = await callServerFn(
    setGraspClientFn,
    { clientId: clientId ?? null },
    { email: staff.email }
  );
  if (chosen.refused !== null) {
    throw new Error(`Choosing ${clientId} was refused: ${chosen.refused}`);
  }
  if (clientDomain !== undefined) {
    env.CLIENT_DOMAIN = clientDomain;
  }
  if (noDispatcher) {
    // An admin deployed without the binding, as a local run can be.
    Reflect.set(env, "DISPATCHER", undefined);
  }
  try {
    return await run();
  } finally {
    env.CLIENT_DOMAIN = before.CLIENT_DOMAIN;
    env.DISPATCHER = before.DISPATCHER;
  }
};

/** Client `clientId`'s hostname, as the router's map keys it. */
const hostKeyOf = (clientId: string): string =>
  routerHostKey(`${clientId}.${env.CLIENT_DOMAIN}`);

const document = "# Grasp's admin\n\n## Noordkade\n- Interviews done: 12 of 20";

/** Asks as the chat does, as staff. */
const ask = async (said: { role: "user" | "assistant"; text: string }[]) =>
  await callServerFn(askGraspFn, { document, said }, { email: staff.email });

/** What the chat gets back when it can't ask, for `refused`. */
const cannotAsk = (refused: string, more: { secret?: string } = {}) => ({
  text: null,
  truncated: false,
  refused,
  ...more,
});
const question = [{ role: "user" as const, text: "Which company?" }];

describe("Ask Grasp", () => {
  useStoreSecrets({ deployer: token });
  eachTest();

  it("says no organization is named as Grasp's own, and asks nothing", async () => {
    const { account } = await liveClient();
    const answer = await asGrasp(undefined, async () => await ask(question));
    expect({ answer, asked: account.asked.length }).toStrictEqual({
      answer: cannotAsk("grasp_client_unset"),
      asked: 0,
    });
  });

  it("says the organization chosen as Grasp's own is one the admin no longer has", async () => {
    const { account } = await liveClient();
    const gone = `client-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date();
    await db
      .insert(clients)
      .values({ id: gone, name: gone, createdAt: now, updatedAt: now });
    const answer = await asGrasp(gone, async () => {
      // Discarded after it was chosen.
      await db.delete(clients).where(eq(clients.id, gone));
      return await ask(question);
    });
    expect({ answer, asked: account.asked.length }).toStrictEqual({
      answer: cannotAsk("grasp_client_unknown"),
      asked: 0,
    });
  });

  it("says Grasp's own organization isn't live, while it's still being set up", async () => {
    const { clientId, account } = await liveClient();
    await db
      .update(clients)
      .set({ status: "provisioning" })
      .where(eq(clients.id, clientId));
    const answer = await asGrasp(clientId, async () => await ask(question));
    expect({ answer, asked: account.asked.length }).toStrictEqual({
      answer: cannotAsk("grasp_client_not_active"),
      asked: 0,
    });
  });

  it("names the secret missing from Secrets Store that the question is signed with", async () => {
    const { clientId, account } = await liveClient();
    await emptyStoreSecret(env.CLIENT_KEY, "CLIENT_KEY");
    const answer = await asGrasp(clientId, async () => await ask(question));
    expect({ answer, asked: account.asked.length }).toStrictEqual({
      answer: cannotAsk("secret_missing", { secret: "CLIENT_KEY" }),
      asked: 0,
    });
  });

  it("says no client domain is set, so Grasp's own organization has no hostname", async () => {
    const { clientId, account } = await liveClient();
    const answer = await asGrasp(clientId, async () => await ask(question), {
      clientDomain: "",
    });
    expect({ answer, asked: account.asked.length }).toStrictEqual({
      answer: cannotAsk("no_client_domain"),
      asked: 0,
    });
  });

  it("says the router has no route to Grasp's own organization", async () => {
    const { clientId, account } = await liveClient();
    await env.ROUTER_HOSTS.delete(hostKeyOf(clientId));
    const answer = await asGrasp(clientId, async () => await ask(question));
    expect({ answer, asked: account.asked.length }).toStrictEqual({
      answer: cannotAsk("not_routed"),
      asked: 0,
    });
  });

  it("says Grasp's own core runs where the admin has no dispatcher to reach it", async () => {
    const { clientId, account } = await liveClient();
    await env.ROUTER_HOSTS.put(
      hostKeyOf(clientId),
      JSON.stringify({ clientId, script: `${clientId}-core`, generation: 1 })
    );
    const answer = await asGrasp(clientId, async () => await ask(question), {
      noDispatcher: true,
    });
    expect({ answer, asked: account.asked.length }).toStrictEqual({
      answer: cannotAsk("core_unreachable"),
      asked: 0,
    });
  });

  it("asks Grasp's own core, signed, naming the staff member, with the document and the conversation as turns", async () => {
    const { clientId, account } = await liveClient();
    account.ask = { text: "Noordkade: 12 of 20 interviews.", truncated: false };
    const answer = await asGrasp(
      clientId,
      async () =>
        await ask([
          { role: "user", text: "Not answered" },
          { role: "user", text: "How many companies?" },
          { role: "assistant", text: "One." },
          { role: "user", text: "Which one is furthest?" },
        ])
    );
    const [asked] = account.asked;
    expect({
      answer,
      staff: asked?.staff.email,
      document: asked?.document,
      // The question that got no answer isn't sent beside the next.
      turns: asked?.turns,
    }).toStrictEqual({
      answer: {
        text: "Noordkade: 12 of 20 interviews.",
        truncated: false,
        refused: null,
      },
      staff: staff.email,
      document,
      turns: [
        { role: "user", text: "How many companies?" },
        { role: "assistant", text: "One." },
        { role: "user", text: "Which one is furthest?" },
      ],
    });
  });

  it("says when Grasp's own core has no model it may send the document to", async () => {
    const { clientId, account } = await liveClient();
    account.ask = "no_model";
    const answer = await asGrasp(
      clientId,
      async () => await ask([{ role: "user", text: "Which company?" }])
    );
    expect(answer).toStrictEqual({
      text: null,
      truncated: false,
      refused: "no_model",
    });
  });

  it("never follows a redirect from Grasp's own core: the question goes nowhere else and gets no answer", async () => {
    const { clientId, account } = await liveClient();
    account.ask = { text: "Answered elsewhere.", truncated: false };
    account.redirectsTo = "https://elsewhere.example";
    const answer = await asGrasp(
      clientId,
      async () => await ask([{ role: "user", text: "Which company?" }])
    );
    expect({
      answer,
      asked: account.asked.length,
      redirected: cloudflare.redirected(),
    }).toStrictEqual({
      answer: { text: null, truncated: false, refused: "not_answered" },
      asked: 0,
      redirected: [],
    });
  });
});

describe("Grasp's own organization", () => {
  useStoreSecrets({ deployer: token });
  eachTest();

  it("is chosen by staff on Platform, audited as them, and shown there", async () => {
    const { clientId } = await liveClient();

    const chosen = await callServerFn(
      setGraspClientFn,
      { clientId },
      { email: staff.email }
    );
    const settings = await callServerFn(fetchPlatformSettings);
    const { html } = await page("/platform", staff.email);
    const events = await db
      .select({ actor: auditEvents.actor })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "platform.grasp_client"),
          eq(auditEvents.clientId, clientId)
        )
      );

    expect({
      chosen,
      graspClientId: settings.graspClientId,
      shown: html.includes(`Noordkade ${clientId} answers Ask Grasp`),
      events,
    }).toStrictEqual({
      chosen: { refused: null },
      graspClientId: clientId,
      shown: true,
      events: [{ actor: staff.email }],
    });
  });

  it("refuses an organization the admin doesn't have, or one offboarded, and keeps the one chosen", async () => {
    const { clientId } = await liveClient();
    const { clientId: offboarded } = await liveClient();
    await callServerFn(setGraspClientFn, { clientId }, { email: staff.email });
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.id, offboarded));

    const refused = await Promise.all(
      ["client-nobody", offboarded].map(
        async (id) =>
          await callServerFn(
            setGraspClientFn,
            { clientId: id },
            { email: staff.email }
          )
      )
    );
    const settings = await callServerFn(fetchPlatformSettings);

    expect({
      refused,
      graspClientId: settings.graspClientId,
    }).toStrictEqual({
      refused: [{ refused: "client_unknown" }, { refused: "client_unknown" }],
      graspClientId: clientId,
    });
  });

  it("is chosen only by staff Access vouches for, from the admin's own pages", async () => {
    const { clientId } = await liveClient();
    await callServerFn(
      setGraspClientFn,
      { clientId: null },
      { email: staff.email }
    );

    const refusals = await Promise.allSettled([
      callServerFn(setGraspClientFn, { clientId }, { email: null }),
      callServerFn(
        setGraspClientFn,
        { clientId },
        { email: staff.email, from: "https://elsewhere.test" }
      ),
    ]);
    const settings = await callServerFn(fetchPlatformSettings);

    expect({
      refusals: refusals.map(({ status }) => status),
      graspClientId: settings.graspClientId,
    }).toStrictEqual({
      refusals: ["rejected", "rejected"],
      graspClientId: null,
    });
  });
});
