import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { givenUpShownMs } from "../src/revocations-by-hand.ts";
import { owedForMs, stuckAttempts } from "../src/revocations.ts";
import { connectApp, fakeApps } from "./app-provider.ts";
import { auditEvents, outcome, runMaintenance, someone } from "./connect.ts";
import { sampleOAuthAuthHost } from "./fixtures/sample-oauth-connector.ts";
import { fakeProviders } from "./oauth-provider.ts";

// The revokes at a provider connect couldn't make, shown to the company's
// admins to make by hand (GRA-1197), from its threat model first:
// - a list that tells more than it must: a personal connection's account,
//   a token, anything a connection read;
// - someone else reading it, or Grasp's staff reading it unseen;
// - alert fatigue: a revoke listed on its first failed try, or one given
//   up listed for ever.

fakeProviders();
const apps = fakeApps();
const audit = auditEvents();

const revokeAt = `https://${sampleOAuthAuthHost}/oauth/revoke`;

/** The app's revocation endpoint, down for good. */
const providerDown = () => {
  const through =
    vi.mocked(globalThis.fetch).getMockImplementation() ?? globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const { url } = new Request(input, init);
    return url.startsWith(revokeAt)
      ? new Response("Down", { status: 503 })
      : await through(input, init);
  });
};

/** A connection of the app for `person`, disconnected while its revoke failed. */
const owedFor = async (
  person: ConnectionPerson,
  scope: "personal" | "shared" = "personal"
) => {
  const account = apps.account("sample-oauth", person.email);
  const connectionId = await connectApp(apps, person, account, scope);
  const refreshToken =
    apps.issued.findLast((token) => token.startsWith("app-refresh-")) ?? "";
  providerDown();
  await exports.default.disconnect({ person, connectionId });
  return { account, connectionId, refreshToken };
};

/** Connection `id`'s owed revoke, failed `attempts` times. */
const failed = async (id: string, attempts: number): Promise<void> => {
  await env.DB.prepare(
    "UPDATE token_revocations SET attempts = ?, retry_at = ? WHERE connection_id = ?"
  )
    .bind(attempts, Date.now() + 60 * 60 * 1000, id)
    .run();
};

/** What an admin is shown for connection `id`. */
const shownFor = async (id: string) => {
  const listed = await exports.default.revocationsByHand({
    person: someone("admin"),
  });
  return listed.filter(({ connectionId }) => connectionId === id);
};

describe("the revokes to make by hand", () => {
  it("lists a revoke only once it is stuck, a personal connection by its owner, never its account", async () => {
    const person = someone();
    const { account, connectionId, refreshToken } = await owedFor(person);

    await failed(connectionId, stuckAttempts - 1);
    const early = await shownFor(connectionId);
    await failed(connectionId, stuckAttempts);
    const stuck = await shownFor(connectionId);
    const told = JSON.stringify(stuck);

    expect({
      early,
      stuck,
      named: [account.email, account.name, account.id, refreshToken].some(
        (secret) => secret !== undefined && told.includes(secret)
      ),
    }).toMatchObject({
      early: [],
      stuck: [
        {
          connectionId,
          provider: "sample-oauth",
          scope: "personal",
          state: "stuck",
          owedFor: "disconnected",
          attempts: stuckAttempts,
          givenUpAt: null,
          accountName: null,
          ownerUserId: person.userId,
        },
      ],
      named: false,
    });
  });

  it("names a shared connection by its account, as admins see it on Integrations", async () => {
    const admin = someone("admin");
    const { account, connectionId } = await owedFor(admin, "shared");
    await failed(connectionId, stuckAttempts);

    await expect(shownFor(connectionId)).resolves.toMatchObject([
      { scope: "shared", accountName: account.name, ownerUserId: null },
    ]);
  });

  it("keeps a revoke given up listed, with nothing to revoke with, and forgets it once it has been for long enough", async () => {
    const person = someone();
    const { connectionId } = await owedFor(person);
    await env.DB.prepare(
      "UPDATE token_revocations SET created_at = ?, retry_at = 0 WHERE connection_id = ?"
    )
      .bind(Date.now() - owedForMs - 1000, connectionId)
      .run();
    const logged = vi.spyOn(console, "error").mockReturnValue();
    await runMaintenance();
    logged.mockRestore();

    const givenUp = await shownFor(connectionId);
    const kept = await env.DB.prepare(
      "SELECT count(*) AS n FROM token_revocations WHERE connection_id = ?"
    )
      .bind(connectionId)
      .first<number>("n");
    await env.DB.prepare(
      "UPDATE given_up_revocations SET given_up_at = ? WHERE connection_id = ?"
    )
      .bind(Date.now() - givenUpShownMs - 1000, connectionId)
      .run();
    await runMaintenance();

    expect({
      givenUp,
      dated: typeof givenUp[0]?.givenUpAt,
      kept,
      later: await shownFor(connectionId),
    }).toMatchObject({
      givenUp: [
        {
          state: "given_up",
          reason: "expired",
        },
      ],
      dated: "string",
      kept: 0,
      later: [],
    });
  });

  it("is for the company's admins, and Grasp's staff read-only on record; anyone else is refused, on record", async () => {
    const person = someone();
    const { connectionId } = await owedFor(person);
    await failed(connectionId, stuckAttempts);
    const staff = { ...someone("admin"), staff: true };

    const builder = await outcome(
      exports.default.revocationsByHand({ person: someone("builder") })
    );
    const seenByStaff = await exports.default.revocationsByHand({
      person: staff,
    });
    const recorded = await audit.events();

    expect({
      builder,
      staff: seenByStaff.some((each) => each.connectionId === connectionId),
      refused: recorded.some(
        ({ action, detail }) =>
          action === "connection.revocations.viewed" &&
          detail.outcome === "refused" &&
          detail.reason === "role.forbidden"
      ),
      viewed: recorded
        .filter(
          ({ action, detail }) =>
            action === "connection.revocations.viewed" &&
            detail.outcome !== "refused"
        )
        .map(({ actor }) => actor),
    }).toMatchObject({
      builder: "role.forbidden",
      staff: true,
      refused: true,
      viewed: [{ type: "staff", userId: staff.userId }],
    });
  });
});
