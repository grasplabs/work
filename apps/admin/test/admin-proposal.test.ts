import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { formatDate } from "../src/admin/words.ts";
import { adminDatabase } from "../src/db/act.ts";
import { auditEvents, clients } from "../src/db/schema.ts";
import { setRoomsProjectFn } from "../src/proposal/functions.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { callServerFn, page } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { fakeRooms, roomsOrigin } from "./rooms-fake.ts";
import { setStoreSecret, useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-admin-proposal-5b8c20";
/** Rooms' service token; never a real one. */
const roomsToken = "rooms-read-token-admin-proposal-fake-0a9d7e3b";

const cloudflare = mockCloudflareApi(token);
mockAccess();
const rooms = fakeRooms(roomsToken);

const db = adminDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/**
 * Before each test: only its own clients are read (an earlier test's
 * accounts are gone from the fakes, and its customers with them), and with
 * `withKey`, Rooms' token is in Secrets Store, as someone at Grasp
 * would put it there (after `useStoreSecrets`, which takes it out after).
 */
const eachTest = ({ withKey }: { withKey: boolean }): void => {
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
    if (withKey) {
      await setStoreSecret(
        env.ROOMS_READ_TOKEN,
        "ROOMS_READ_TOKEN",
        roomsToken
      );
    }
  });
};

/** An active client running a new release, as a deploy made it live, whose core answers an empty snapshot. */
const liveClient = async () => {
  const release = await placedRelease("feat(core): proposal");
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const name = `Noordkade ${clientId}`;
  const { account } = await livePlacedClient(cloudflare, 1, release, {
    id: clientId,
    name,
    signIn: null,
  });
  account.admin = emptyAdminSnapshot("Noordkade");
  return clientId;
};

/** Links `clientId` to room `projectId` (null unlinks), as staff do under its Contract. */
const link = async (clientId: string, projectId: string | null) =>
  await callServerFn(
    setRoomsProjectFn,
    { clientId, projectId },
    { email: staff.email }
  );

/** The page's main part, past the column of sections. */
const mainOf = (html: string): string => html.slice(html.indexOf("<main"));

/** The text of the line under `label`, tags taken out. */
const lineOf = (html: string, label: string): string => {
  const at = html.indexOf(`>${label}</dt>`);
  if (at === -1) {
    return "";
  }
  const start = html.indexOf("<dd", at);
  const end = html.indexOf("</dd>", start);
  return html
    .slice(html.indexOf(">", start) + 1, end)
    .replaceAll(/<[^>]*>/gu, "");
};

const contractOf = async (clientId: string): Promise<string> => {
  const { html } = await page(`/organizations/${clientId}/contract`);
  return mainOf(html);
};

const day = 24 * 60 * 60 * 1000;
const now = Date.now();
/** A time in milliseconds as the day the page says it is. */
const dayOf = (millis: number): string =>
  formatDate(new Date(millis).toISOString().slice(0, 10));

/** A room whose proposal Ilse signed, after a first request to her was withdrawn. */
const signedRoom = (projectId: string) => {
  const signedAt = now - 3 * day;
  return {
    signedAt,
    room: {
      project: {
        id: projectId,
        name: "Noordkade proposal",
        clientName: "Noordkade B.V.",
        slug: "noordkade-proposal",
        status: "active",
        revision: 3,
        createdAt: now - 20 * day,
        updatedAt: signedAt,
      },
      signing: {
        available: true,
        checkedAt: now,
        requests: [
          {
            id: crypto.randomUUID(),
            projectId,
            versionId: crypto.randomUUID(),
            signerName: "Ilse de Vries",
            signerEmail: "ilse@noordkade.test",
            snapshotHash: "a".repeat(64),
            status: "signed",
            createdAt: now - 5 * day,
            expiresAt: now + 9 * day,
            signedAt,
            message: "",
          },
          {
            id: crypto.randomUUID(),
            projectId,
            versionId: crypto.randomUUID(),
            signerName: "Ilse de Vries",
            signerEmail: "ilse@noordkade.test",
            snapshotHash: "b".repeat(64),
            status: "revoked",
            createdAt: now - 8 * day,
            expiresAt: now + 6 * day,
            signedAt: null,
            message: "",
          },
        ],
      },
    },
  };
};

describe("an organization's proposal, with Rooms' token", () => {
  useStoreSecrets({ deployer: token });
  eachTest({ withKey: true });

  it("shows a linked company's room, who signed it and when, read only", async () => {
    const clientId = await liveClient();
    const projectId = crypto.randomUUID();
    const { room, signedAt } = signedRoom(projectId);
    rooms.rooms.set(projectId, room);

    const linked = await link(clientId, projectId);
    const contract = await contractOf(clientId);

    expect({
      linked,
      line: contract.includes(`Signed by Ilse de Vries on ${dayOf(signedAt)}.`),
      room: lineOf(contract, "Room in Rooms"),
      opens: contract.includes(`${roomsOrigin}/rooms/${projectId}`),
      for: lineOf(contract, "For"),
      signatures: ["Signed", "Withdrawn"].map((word) =>
        contract.includes(`>${word}</span>`)
      ),
      notConnected: contract.includes("Once Rooms is connected"),
      // The token never reaches the page.
      token: contract.includes(roomsToken),
      writes: rooms.writes,
    }).toStrictEqual({
      linked: { changed: true, refused: null },
      line: true,
      room: "Noordkade proposal",
      opens: true,
      for: "Noordkade B.V.",
      signatures: [true, true],
      notConnected: false,
      token: false,
      writes: 0,
    });
  });

  it("says when Rooms has no such room, and still offers the link", async () => {
    const clientId = await liveClient();
    await link(clientId, crypto.randomUUID());
    const contract = await contractOf(clientId);
    expect({
      line: contract.includes(
        "Rooms can’t be read for it now: Rooms has no such room."
      ),
      form: contract.includes('name="projectId"'),
    }).toStrictEqual({ line: true, form: true });
  });

  it("refuses a room Rooms answers for another id", async () => {
    const clientId = await liveClient();
    const projectId = crypto.randomUUID();
    rooms.rooms.set(projectId, signedRoom(crypto.randomUUID()).room);
    await link(clientId, projectId);
    const contract = await contractOf(clientId);
    expect({
      line: contract.includes("what Rooms answered can’t be read"),
      shown: contract.includes("Noordkade proposal"),
    }).toStrictEqual({ line: true, shown: false });
  });

  it("links only by a room's id, audits each change, and unlinks", async () => {
    const clientId = await liveClient();
    const projectId = crypto.randomUUID();

    const byName = await link(clientId, "Noordkade proposal");
    const linked = await link(clientId, projectId.toUpperCase());
    const again = await link(clientId, projectId);
    const unlinked = await link(clientId, null);
    const unknown = await link("no-such-client", projectId);
    const events = await db
      .select({ actor: auditEvents.actor, target: auditEvents.target })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "client.rooms_project")
        )
      )
      .orderBy(auditEvents.at);
    const [row] = await db
      .select({ projectId: clients.roomsProjectId })
      .from(clients)
      .where(eq(clients.id, clientId));

    expect({
      byName,
      linked,
      again,
      unlinked,
      unknown,
      events,
      row,
    }).toStrictEqual({
      byName: { changed: null, refused: "project_id_invalid" },
      linked: { changed: true, refused: null },
      again: { changed: false, refused: null },
      unlinked: { changed: true, refused: null },
      unknown: { changed: null, refused: "unknown_client" },
      events: [
        { actor: staff.email, target: projectId },
        { actor: staff.email, target: null },
      ],
      row: { projectId: null },
    });
  });
});

describe("an organization's proposal, without Rooms' token", () => {
  useStoreSecrets({ deployer: token });
  eachTest({ withKey: false });

  it("says Rooms isn't connected and asks Rooms nothing", async () => {
    const clientId = await liveClient();
    await link(clientId, crypto.randomUUID());
    const contract = await contractOf(clientId);
    expect({
      line: contract.includes("Once Rooms is connected"),
      requests: rooms.requests,
    }).toStrictEqual({ line: true, requests: 0 });
  });
});
