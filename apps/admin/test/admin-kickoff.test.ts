import type { AdminKickoffView } from "@grasp-os/shared/admin-kickoff";
import { transcriptBase64MaxLength } from "@grasp-os/shared/admin-kickoff";
import { toBase64 } from "@grasp-os/shared/encoding";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { kickoffFn } from "../src/clients/kickoff-functions.ts";
import { adminDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { callServerFn } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
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

const cloudflare = mockCloudflareApi(token);
mockAccess();

const db = adminDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** An active client running a new release, as a deploy made it live. */
const liveClient = async () => {
  const release = await placedRelease("feat(core): kickoff");
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
  useStoreSecrets({ deployer: token });

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

    // One after another: the file's first requests load the app's modules,
    // and in the test pool a second request waiting on a module the first
    // is loading is cancelled as hung (test/pages.ts).
    const asks = [
      async () =>
        await bringIn(clientId, fileOf(transcript), null).then(
          () => "answered",
          () => "refused"
        ),
      async () =>
        await bringIn(clientId, "A".repeat(transcriptBase64MaxLength + 4)).then(
          () => "answered",
          () => "refused"
        ),
      async () => await bringIn(offboarded.clientId, fileOf(transcript)),
      async () => await bringIn("no-such-client", fileOf(transcript)),
    ];
    const outcomes: unknown[] = [];
    for (const ask of asks) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time, as above
      outcomes.push(await ask());
    }
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
