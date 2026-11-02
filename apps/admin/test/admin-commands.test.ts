import type { AdminCommand } from "@grasp-os/shared/admin-command";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { commandFn } from "../src/clients/command-functions.ts";
import { adminDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { callServerFn } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// Steering a client's onboarding from its pages (src/clients/commands.ts).
// The ways it can fail, tried first: a caller Access doesn't vouch for, a
// command the admin couldn't make, an organization that isn't the one
// asked for (or isn't deployed), and a company that keeps Grasp's staff
// out. Each client's core is the fake's: it checks the signature with
// that client's own key for commands, as core does (core's
// src/admin-command.ts, whose own tests try the signature's attacks and
// deliver the same command twice).

const token = "test-deployer-token-admin-commands-7c2d9a";

const cloudflare = mockCloudflareApi(token);
mockAccess();

const db = adminDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** An active client running a new release, as a deploy made it live. */
const liveClient = async () => {
  const release = await placedRelease("feat(core): commands");
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const { account } = await livePlacedClient(cloudflare, 1, release, {
    id: clientId,
    name: `Noordkade ${clientId}`,
    signIn: null,
  });
  account.admin = emptyAdminSnapshot("Noordkade");
  return { clientId, account };
};

const pause: AdminCommand = { type: "onboarding.pause", payload: {} };

/** Gives `command` to `clientId`'s onboarding under `id`, issued at `issuedAt`, as staff (or as nobody, for null). */
const give = async (
  clientId: string,
  command: AdminCommand,
  email: string | null = staff.email,
  id: string = crypto.randomUUID(),
  issuedAt: string = new Date().toISOString()
) =>
  await callServerFn(commandFn, { clientId, id, issuedAt, command }, { email });

describe("commands from an organization's pages", () => {
  useStoreSecrets({ deployer: token });

  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
  });

  it("go to no core for a caller Access doesn't vouch for, a command the admin can't make, an id that isn't one, or an organization not deployed", async () => {
    const { clientId, account } = await liveClient();
    const offboarded = await liveClient();
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.id, offboarded.clientId));

    const outcomes = await Promise.all([
      give(clientId, pause, null).then(
        () => "answered",
        () => "refused"
      ),
      give("x".repeat(64), pause).then(
        () => "answered",
        () => "refused"
      ),
      give(clientId, {
        type: "onboarding.remind",
        payload: { people: [] },
      }).then(
        () => "answered",
        () => "refused"
      ),
      give(clientId, pause, staff.email, "again").then(
        () => "answered",
        () => "refused"
      ),
      give(offboarded.clientId, pause),
      give("no-such-client", pause),
    ]);
    expect({
      outcomes,
      sent: account.commands.length + offboarded.account.commands.length,
    }).toStrictEqual({
      outcomes: [
        "refused",
        "refused",
        "refused",
        "refused",
        { refused: "not_deployed" },
        { refused: "not_deployed" },
      ],
      sent: 0,
    });
  });

  it("go to the organization asked for alone, signed with its own key, under the id the page gave, naming the staff member", async () => {
    const asked = await liveClient();
    const other = await liveClient();
    const remind: AdminCommand = {
      type: "onboarding.remind",
      payload: { people: ["lisa", "tom"] },
    };
    const remindId = crypto.randomUUID();
    const pauseId = crypto.randomUUID();
    const issuedAt = new Date().toISOString();

    const answers = [
      await give(asked.clientId, remind, staff.email, remindId),
      await give(asked.clientId, pause, staff.email, pauseId, issuedAt),
      // Given again after an answer that didn't come: the same id, issued
      // when it was, so core applies it once (core's src/admin-command.ts).
      await give(asked.clientId, pause, staff.email, pauseId, issuedAt),
    ];
    expect({
      answers,
      commands: asked.account.commands.map(({ type, payload, staff: by }) => ({
        type,
        payload,
        by: by.email,
      })),
      ids: asked.account.commands.map(({ id }) => id),
      issued: asked.account.commands
        .slice(1)
        .map((each) => each.issuedAt === issuedAt),
      other: other.account.commands.length,
    }).toStrictEqual({
      answers: [{ refused: null }, { refused: null }, { refused: null }],
      commands: [
        { ...remind, by: staff.email },
        { ...pause, by: staff.email },
        { ...pause, by: staff.email },
      ],
      ids: [remindId, pauseId, pauseId],
      issued: [true, true],
      other: 0,
    });
  });

  it("say why the company's core didn't apply one", async () => {
    const { clientId, account } = await liveClient();
    const askIn: AdminCommand = {
      type: "onboarding.ask_in",
      payload: { team: "labs" },
    };
    /** What the page is told when core refuses with `refusal`. */
    const toldFor = async (refusal: { status: number; code: string }) => {
      account.commandRefusal = refusal;
      return await give(clientId, askIn);
    };
    const answers = [
      await toldFor({ status: 403, code: "onboarding.staff_only" }),
      await toldFor({ status: 409, code: "admin.command_pending" }),
      await toldFor({ status: 409, code: "onboarding.no_team" }),
      await toldFor({ status: 500, code: "request.failed" }),
    ];
    expect(answers).toStrictEqual([
      { refused: "shut_out" },
      { refused: "pending" },
      { refused: "onboarding.no_team" },
      { refused: "not_answered" },
    ]);
  });
});
