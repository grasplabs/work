/**
 * A client's own key material, sealed for the one host it relocates to
 * (spec 46.1): the secrets derived for it that its core and connect run
 * with, encrypted to that host's public key (a JWE, ECDH-ES+A256KW with
 * A256GCM), so only the holder of the private key reads them. A relocated
 * client keeps decrypting what it sealed (connect's OAuth tokens), signing
 * what it signs and taking its own sessions.
 *
 * Never in it: the master keys the console derives every client's secrets
 * from (`ROUTER_KEY`, `CLIENT_KEY`), the secrets every client shares
 * (Grasp's own provider keys), another client's material or any
 * deployment credential. Each export is an explicit staff action, audited
 * with the recipient key's thumbprint, never a value; an offboarded
 * client's material isn't exported.
 */
import { eq } from "drizzle-orm";
import { calculateJwkThumbprint, CompactEncrypt, importJWK } from "jose";
import { z } from "zod";

import { audit } from "../db/act.ts";
import type { Actor, ConsoleDatabase } from "../db/act.ts";
import { clients } from "../db/schema.ts";
import { derivedSecretApps, derivedWorkerSecrets } from "./secrets.ts";
import type { DeploySecrets } from "./secrets.ts";

export const secretExportErrorCodes = [
  /** No client by that id. */
  "client_unknown",
  /** The client is offboarded: its material leaves with nobody. */
  "client_offboarded",
  /** The recipient isn't a P-256 public key: a private one, or another kind. */
  "recipient_invalid",
] as const;

export type SecretExportErrorCode = (typeof secretExportErrorCodes)[number];

/** Why an export stopped: a fixed code, never a value. */
export class SecretExportError extends Error {
  readonly code: SecretExportErrorCode;

  constructor(code: SecretExportErrorCode, message: string) {
    super(message);
    this.name = "SecretExportError";
    this.code = code;
  }
}

/** The recipient's public key: P-256 only, and never with its private part. */
const recipientSchema = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().min(1),
  y: z.string().min(1),
  kid: z.string().optional(),
  use: z.literal("enc").optional(),
  alg: z.literal("ECDH-ES+A256KW").optional(),
});

export type RecipientKey = z.infer<typeof recipientSchema>;

/** What the sealed payload holds, once decrypted. */
export interface ClientSecretMaterial {
  version: 1;
  clientId: string;
  generation: number;
  exportedAt: string;
  /** By app (`core`, `connect`), then by secret name. */
  secrets: Record<string, Record<string, string>>;
}

/** The content type the JWE names its payload with. */
export const clientSecretsContentType = "grasp-client-secrets+json";

/**
 * Seals client `clientId`'s key material for `recipient`, as staff member
 * `actor` asks, after auditing the export by the recipient's thumbprint.
 * Returns the compact JWE.
 */
export const exportClientSecrets = async (
  db: ConsoleDatabase,
  actor: Actor,
  keys: Pick<DeploySecrets, "routerKey" | "clientKey">,
  request: { clientId: string; recipient: unknown; now: Date }
): Promise<string> => {
  const parsed = recipientSchema.safeParse(request.recipient);
  if (!parsed.success) {
    throw new SecretExportError(
      "recipient_invalid",
      "The recipient must be a P-256 public key, without its private part"
    );
  }
  const recipient = parsed.data;
  const client = await db
    .select()
    .from(clients)
    .where(eq(clients.id, request.clientId))
    .get();
  if (client === undefined) {
    throw new SecretExportError(
      "client_unknown",
      `No client ${request.clientId}`
    );
  }
  if (client.status === "offboarded") {
    throw new SecretExportError(
      "client_offboarded",
      `${client.id} is offboarded`
    );
  }

  const generation = {
    id: client.id,
    generation: client.generation,
    rotationLiveAt: client.rotationLiveAt,
  };
  const secrets: Record<string, Record<string, string>> = {};
  for (const app of derivedSecretApps) {
    secrets[app] = Object.fromEntries(
      // oxlint-disable-next-line no-await-in-loop -- core and connect
      await derivedWorkerSecrets(app, keys, generation, request.now)
    );
  }
  const material: ClientSecretMaterial = {
    version: 1,
    clientId: client.id,
    generation: client.generation,
    exportedAt: request.now.toISOString(),
    secrets,
  };

  const thumbprint = await calculateJwkThumbprint(recipient);
  // On record before anything is sealed: an export that then fails is
  // still an audited attempt.
  await audit(db, actor, {
    action: "client.secrets_export",
    clientId: client.id,
    target: thumbprint,
    detail: {
      generation: client.generation,
      apps: Object.keys(secrets).join(","),
    },
  });
  const key = await importJWK(recipient, "ECDH-ES+A256KW");
  return await new CompactEncrypt(
    new TextEncoder().encode(JSON.stringify(material))
  )
    .setProtectedHeader({
      alg: "ECDH-ES+A256KW",
      enc: "A256GCM",
      kid: thumbprint,
      cty: clientSecretsContentType,
    })
    .encrypt(key);
};
