import {
  adminSnapshotPath,
  adminSnapshotPurpose,
  adminSnapshotSchema,
} from "@grasp-os/shared/admin-snapshot";
import type { AdminStephenSignals } from "@grasp-os/shared/admin-snapshot";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { routed } from "./sign-in.ts";
import {
  member,
  messageFrom,
  post,
  reached,
  uninstalledFor,
  watched,
} from "./teams-door.ts";

// How Stephen fares in the chat apps, as Grasp's admin reads it in the
// admin snapshot (src/channels/signals.ts, src/admin-snapshot.ts): each
// count moved by what really happened at the door and in a turn, and
// nothing anyone wrote, nor who, in what the admin reads.

const idp = mockIdp();

watched();

/** Signing people in and running turns can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** Words nobody else uses, to look for where they must not be. */
const sentinel = "Marmalade lighthouse at the tram depot";

/** The admin snapshot as the admin reads it: signed, now, for a staff member. */
const snapshotNow = async () => {
  const body = JSON.stringify({
    sentAt: new Date().toISOString(),
    staff: { email: "watch@grasp.test" },
  });
  const key = await hkdfHmacKey(env.BETTER_AUTH_SECRET, adminSnapshotPurpose, [
    "sign",
  ]);
  const signature = toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
  const response = await routed(adminSnapshotPath, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [platformUpdateSignatureHeader]: signature,
    },
    body,
  });
  const text = await response.text();
  return { text, snapshot: adminSnapshotSchema.parse(JSON.parse(text)) };
};

/** Stephen's counts as the admin reads them now. */
const stephenNow = async (): Promise<AdminStephenSignals> => {
  const { snapshot } = await snapshotNow();
  if (snapshot.stephen === null || snapshot.stephen === undefined) {
    throw new Error("Expected Stephen's counts in the snapshot");
  }
  return snapshot.stephen;
};

/** How much each count rose from `before` to `after`. */
const rose = (before: AdminStephenSignals, after: AdminStephenSignals) => ({
  refused: after.refused - before.refused,
  answered: after.answered - before.answered,
  failed: after.failed - before.failed,
  sendFailed: after.sendFailed - before.sendFailed,
  uninstalled: after.uninstalled - before.uninstalled,
});

describe("Stephen's counts in the admin snapshot", setUpTime, () => {
  it("count a turn answered, with its time", async () => {
    const before = await stephenNow();
    const { teams } = await member(idp, says("All done."));

    await post(messageFrom(teams, { text: "Anything new?" }));

    const after = await stephenNow();
    expect(rose(before, after)).toStrictEqual({
      refused: 0,
      answered: 1,
      failed: 0,
      sendFailed: 0,
      uninstalled: 0,
    });
    expect(after.p50Ms).toBeGreaterThan(0);
    expect(after.p90Ms).toBeGreaterThanOrEqual(after.p50Ms ?? 0);
  });

  it("count a turn that failed, and a request the door refused", async () => {
    const before = await stephenNow();
    const { teams } = await member(idp, {
      status: 500,
      errorType: "api_error",
    });

    await post(messageFrom(teams, { text: "Anything new?" }));
    const refused = await post(messageFrom(teams), { authorization: null });

    expect(refused).toBe(401);
    expect(rose(before, await stephenNow())).toStrictEqual({
      refused: 1,
      answered: 0,
      failed: 1,
      sendFailed: 0,
      uninstalled: 0,
    });
  });

  it("count an answer Teams refused as the app was uninstalled", async () => {
    const before = await stephenNow();
    const { teams } = await member(idp, says("You won't see this."));
    await uninstalledFor(teams);

    await post(messageFrom(teams, { text: "Still there?" }));

    const { lines } = await reached(teams.conversation);
    expect(lines).toStrictEqual([]);
    expect(rose(before, await stephenNow())).toStrictEqual({
      refused: 0,
      answered: 0,
      failed: 0,
      sendFailed: 1,
      uninstalled: 1,
    });
  });

  it("carry nothing anyone wrote, nor who wrote it or where", async () => {
    const { userId, teams } = await member(
      idp,
      says(`${sentinel}, said back.`)
    );

    await post(messageFrom(teams, { text: sentinel }));

    const { text } = await snapshotNow();
    const { stephen } = adminSnapshotSchema.parse(JSON.parse(text));
    expect(stephen?.answered).toBeGreaterThan(0);
    expect(
      [sentinel, teams.conversation, teams.aadObjectId, teams.userId].filter(
        (each) => text.includes(each)
      )
    ).toStrictEqual([]);
    // The member is in the snapshot's members, as before; never in its counts.
    expect(JSON.stringify(stephen)).not.toContain(userId);
  });
});
