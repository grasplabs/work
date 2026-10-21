import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import {
  calculateJwkThumbprint,
  compactDecrypt,
  exportJWK,
  generateKeyPair,
} from "jose";
import { describe, expect, it } from "vite-plus/test";

import { consoleDatabase } from "../src/db/act.ts";
import { auditEvents, clients } from "../src/db/schema.ts";
import { exportClientSecrets } from "../src/deploy/secret-export.ts";
import type { ClientSecretMaterial } from "../src/deploy/secret-export.ts";
import { workerSecrets } from "../src/deploy/secrets.ts";
import type { DeploySecrets } from "../src/deploy/secrets.ts";
import { buildRelease } from "./releases.ts";

const db = consoleDatabase(env.DB);
const staff = { email: "staff@grasp.test", sub: "sub-staff" };
const secrets: DeploySecrets = {
  routerKey: "test-router-key-for-exports",
  clientKey: "test-client-key-for-exports",
  shared: { connect: { COMPOSIO_API_KEY: "grasp-composio-key" } },
};
const now = new Date("2026-10-21T10:00:00.000Z");

/** A client record, as provisioning makes one. */
const client = async (
  values: Partial<typeof clients.$inferInsert> = {}
): Promise<string> => {
  const id = `acme-${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(clients).values({
    id,
    name: id,
    accountId: crypto.randomUUID(),
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...values,
  });
  return id;
};

/** A recipient host's key pair: its public JWK, and the private key that opens what's sealed to it. */
const recipient = async () => {
  const { publicKey, privateKey } = await generateKeyPair("ECDH-ES+A256KW", {
    crv: "P-256",
    extractable: true,
  });
  return {
    jwk: await exportJWK(publicKey),
    privateKey,
    privateJwk: await exportJWK(privateKey),
  };
};

const open = async (
  sealed: string,
  privateKey: CryptoKey
): Promise<{
  material: ClientSecretMaterial;
  header: Record<string, unknown>;
}> => {
  const { plaintext, protectedHeader } = await compactDecrypt(
    sealed,
    privateKey
  );
  return {
    // SAFETY: the test reads back what the export sealed as JSON.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    material: JSON.parse(
      new TextDecoder().decode(plaintext)
    ) as ClientSecretMaterial,
    header: protectedHeader,
  };
};

/** What a deploy of `clientId` sets on each Worker, by app then name. */
const deployed = async (
  clientId: string,
  generation: number,
  rotationLiveAt: Date | null
): Promise<Record<string, Record<string, string>>> => {
  const { manifest } = await buildRelease({ notes: "feat(core): test" });
  const byApp: Record<string, Record<string, string>> = {};
  for (const [app, worker] of Object.entries(manifest.workers)) {
    // oxlint-disable-next-line no-await-in-loop -- core and connect
    const running = await workerSecrets(
      app,
      { ...worker, requiredSecrets: [] },
      secrets,
      { id: clientId, generation, rotationLiveAt },
      now
    );
    byApp[app] = Object.fromEntries(
      running.map(({ name, value }) => [name, value])
    );
  }
  return byApp;
};

describe("exporting a client's key material", () => {
  it("seals exactly the client's own derived secrets, as its Workers run them, for the recipient alone", async () => {
    const clientId = await client({ generation: 3, rotationLiveAt: now });
    const other = await client();
    const host = await recipient();
    const stranger = await recipient();

    const sealed = await exportClientSecrets(db, staff, secrets, {
      clientId,
      recipient: host.jwk,
      now,
    });
    const { material, header } = await open(sealed, host.privateKey);

    const running = await deployed(clientId, 3, now);
    expect(material).toStrictEqual({
      version: 1,
      clientId,
      generation: 3,
      rotationLiveAt: now.toISOString(),
      exportedAt: now.toISOString(),
      // What each Worker runs with, but the secret every client shares.
      secrets: {
        core: running.core,
        connect: Object.fromEntries(
          Object.entries(running.connect ?? {}).filter(
            ([name]) => name !== "COMPOSIO_API_KEY"
          )
        ),
      },
    });
    // The rotation's previous keys too, while it overlaps.
    expect(
      Object.keys(material.secrets.connect ?? {}).toSorted()
    ).toStrictEqual([
      "CAPABILITY_SIGNING_KEY",
      "CAPABILITY_SIGNING_KEY_PREVIOUS",
      "TOKEN_ENCRYPTION_KEY",
      "TOKEN_ENCRYPTION_KEY_PREVIOUS",
    ]);
    // Nothing of the master keys, the shared secrets or another client.
    const values = Object.values(material.secrets).flatMap((app) =>
      Object.values(app)
    );
    const theirs = new Set(
      Object.values(await deployed(other, 1, null)).flatMap((app) =>
        Object.values(app)
      )
    );
    expect(
      values.filter(
        (value) =>
          value === secrets.routerKey ||
          value === secrets.clientKey ||
          value === "grasp-composio-key" ||
          theirs.has(value)
      )
    ).toStrictEqual([]);
    expect(header).toMatchObject({
      alg: "ECDH-ES+A256KW",
      enc: "A256GCM",
      kid: await calculateJwkThumbprint(host.jwk),
    });
    await expect(compactDecrypt(sealed, stranger.privateKey)).rejects.toThrow(
      "decryption operation failed"
    );
  });

  it("is audited by the recipient's thumbprint, never a value", async () => {
    const clientId = await client();
    const host = await recipient();

    await exportClientSecrets(db, staff, secrets, {
      clientId,
      recipient: host.jwk,
      now,
    });

    const events = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "client.secrets_export")
        )
      )
      .all();
    expect(
      events.map(({ actor, target, detail }) => ({ actor, target, detail }))
    ).toStrictEqual([
      {
        actor: staff.email,
        target: await calculateJwkThumbprint(host.jwk),
        detail: JSON.stringify({ generation: 1, apps: "core,connect" }),
      },
    ]);
  });

  it("refuses an offboarded client, an unknown one and any recipient but a P-256 public key", async () => {
    const offboarded = await client({ status: "offboarded" });
    const active = await client();
    const host = await recipient();
    const attempt = async (clientId: string, key: unknown) =>
      await exportClientSecrets(db, staff, secrets, {
        clientId,
        recipient: key,
        now,
      }).catch((error: unknown) =>
        error instanceof Error && "code" in error ? error.code : error
      );

    expect({
      offboarded: await attempt(offboarded, host.jwk),
      unknown: await attempt("nobody", host.jwk),
      privateKey: await attempt(active, host.privateJwk),
      symmetric: await attempt(active, { kty: "oct", k: "AAAA" }),
      otherCurve: await attempt(active, { ...host.jwk, crv: "P-384" }),
    }).toStrictEqual({
      offboarded: "client_offboarded",
      unknown: "client_unknown",
      privateKey: "recipient_invalid",
      symmetric: "recipient_invalid",
      otherCurve: "recipient_invalid",
    });
    const recorded = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "client.secrets_export"))
      .all();
    expect(
      recorded.filter(
        ({ clientId }) => clientId === offboarded || clientId === active
      )
    ).toStrictEqual([]);
  });
});
