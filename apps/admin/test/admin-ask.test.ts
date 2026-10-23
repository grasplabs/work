import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { askGraspFn } from "../src/admin/ask-functions.ts";
import { act, adminDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import { runDeploy, startDeploy } from "../src/deploy/deploy.ts";
import { importReleases } from "../src/releases/import.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { callServerFn } from "./pages.ts";
import { publishRelease } from "./releases.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-admin-ask-71c0d2";
const tenantToken = "test-tenant-admin-token-admin-ask-0e93ab";

const cloudflare = mockCloudflareApi(token, tenantToken);
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
  const release = await publishRelease({ notes: "feat(core): ask" });
  await importReleases(env.RELEASES, db);
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const name = `Noordkade ${clientId}`;
  const account = cloudflare.addAccount(name);
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name,
        accountId: account.id,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  await runDeploy(
    await deployContext(env),
    await startDeploy(db, staff, clientId, release.id)
  );
  account.admin = emptyAdminSnapshot("Noordkade");
  return { clientId, account };
};

/** Runs `run` with `GRASP_CLIENT_ID` set to `clientId` (undefined for none). */
const asGrasp = async <T>(
  clientId: string | undefined,
  run: () => Promise<T>
): Promise<T> => {
  const before = env.GRASP_CLIENT_ID;
  env.GRASP_CLIENT_ID = clientId;
  try {
    return await run();
  } finally {
    env.GRASP_CLIENT_ID = before;
  }
};

const document = "# Grasp's admin\n\n## Noordkade\n- Interviews done: 12 of 20";

/** Asks as the chat does, as staff. */
const ask = async (said: { role: "user" | "assistant"; text: string }[]) =>
  await callServerFn(askGraspFn, { document, said }, { email: staff.email });

describe("Ask Grasp", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  eachTest();

  it("says it isn't set up, and asks nothing, while no client is Grasp's own", async () => {
    const { account } = await liveClient();
    const answer = await asGrasp(
      undefined,
      async () => await ask([{ role: "user", text: "Which company?" }])
    );
    expect({ answer, asked: account.asked.length }).toStrictEqual({
      answer: { text: null, truncated: false, refused: "not_set_up" },
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
});
