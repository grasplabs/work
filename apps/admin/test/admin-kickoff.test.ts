import type { AdminKickoffView } from "@grasp-os/shared/admin-kickoff";
import { transcriptBase64MaxLength } from "@grasp-os/shared/admin-kickoff";
import { toBase64 } from "@grasp-os/shared/encoding";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { kickoffFn } from "../src/clients/kickoff-functions.ts";
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

// The kickoff brought in from an organization's Steps (GRA-1099,
// src/clients/kickoff.ts). The ways it can fail, tried first: a caller
// Access doesn't vouch for, an organization that isn't the one asked
// for (or isn't deployed), a file too large, and a company that keeps
// Grasp's staff out. Each client's core is the fake's: it checks the
// signature with that client's own key for the kickoff's purpose, as
// core does (core's src/admin-kickoff.ts, whose own tests try the
// signature's attacks).

const token = "test-deployer-token-admin-kickoff-5a1e3c";
const tenantToken = "test-tenant-admin-token-admin-kickoff-9c27d4";

const cloudflare = mockCloudflareApi(token, tenantToken);
mockAccess();

const db = adminDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** An active client running a new release, as a deploy made it live. */
const liveClient = async () => {
  const release = await publishRelease({ notes: "feat(core): kickoff" });
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

const transcript = "Anna (COO): Wij zijn een hypotheekadviseur in Utrecht.";

/** What core answers once the kickoff is read: one thing said, one left open. */
const brought: AdminKickoffView = {
  transcript: {
    at: new Date().toISOString(),
    fileName: "kickoff.txt",
    characters: transcript.length,
  },
  read: true,
  fields: [
    { field: "business", state: "said", ask: "", answer: null },
    {
      field: "languages",
      state: "open",
      ask: "In welke talen werken de teams?",
      answer: null,
    },
  ],
  teams: 0,
};

/** Brings `file`'s bytes in for `clientId`, as staff (or as nobody, for null). */
const bringIn = async (
  clientId: string,
  base64: string,
  email: string | null = staff.email
) =>
  await callServerFn(
    kickoffFn,
    {
      clientId,
      ask: {
        kind: "save",
        locale: "nl",
        transcript: { file: { name: "kickoff.txt", base64 } },
      },
    },
    { email }
  );

const fileOf = (text: string): string =>
  toBase64(new TextEncoder().encode(text));

describe("the kickoff from an organization's Steps", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });

  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
  });

  it("goes to no core for a caller Access doesn't vouch for, a file too large, or an organization not deployed", async () => {
    const { clientId, account } = await liveClient();
    const offboarded = await liveClient();
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.id, offboarded.clientId));

    const outcomes = await Promise.all([
      bringIn(clientId, fileOf(transcript), null).then(
        () => "answered",
        () => "refused"
      ),
      bringIn(clientId, "A".repeat(transcriptBase64MaxLength + 4)).then(
        () => "answered",
        () => "refused"
      ),
      bringIn(offboarded.clientId, fileOf(transcript)),
      bringIn("no-such-client", fileOf(transcript)),
    ]);
    expect({
      outcomes,
      sent: account.kickoffAsks.length + offboarded.account.kickoffAsks.length,
    }).toStrictEqual({
      outcomes: [
        "refused",
        "refused",
        { kickoff: null, refused: "not_deployed" },
        { kickoff: null, refused: "not_deployed" },
      ],
      sent: 0,
    });
  });

  it("goes to the organization asked for alone, signed with its own key, naming the staff member, and says what it brought", async () => {
    const asked = await liveClient();
    const other = await liveClient();
    asked.account.kickoff = brought;

    const answer = await bringIn(asked.clientId, fileOf(transcript));
    const [sent] = asked.account.kickoffAsks;
    expect({
      answer,
      staff: sent?.staff.email,
      ask: sent?.ask,
      other: other.account.kickoffAsks.length,
    }).toStrictEqual({
      answer: { kickoff: brought, refused: null },
      staff: staff.email,
      ask: {
        kind: "save",
        locale: "nl",
        transcript: {
          file: { name: "kickoff.txt", base64: fileOf(transcript) },
        },
      },
      other: 0,
    });
  });

  it("says when the company keeps Grasp's staff out", async () => {
    const { clientId, account } = await liveClient();
    account.kickoff = "shut_out";
    const [read, answered] = await Promise.all([
      callServerFn(
        kickoffFn,
        { clientId, ask: { kind: "read" } },
        { email: staff.email }
      ),
      callServerFn(
        kickoffFn,
        {
          clientId,
          ask: { kind: "answer", field: "languages", text: "Nederlands" },
        },
        { email: staff.email }
      ),
    ]);
    expect([read, answered]).toStrictEqual([
      { kickoff: null, refused: "shut_out" },
      { kickoff: null, refused: "shut_out" },
    ]);
  });
});
