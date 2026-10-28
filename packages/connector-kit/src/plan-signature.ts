import { z } from "zod";

import { connectorNameSchema, hostSchema } from "./manifest.ts";

// An approved build plan, signed (GRA-689): when a person at Grasp approves
// the plan Grasp's agent wrote for a new app's connector, the admin signs
// it with a key of its own (the admin's src/builds/plan-signing.ts), and
// the plan and its signature go into the connector's folder on the
// agent's branch. CI holds the branch to it (scripts/connector-guard.ts):
// the signature must verify with the admin's public key, and the
// connector's manifest may name no host the approved plan doesn't. The
// agent can't sign a plan of its own: it never holds the key.
//
// Ed25519 over the plan document's exact text, both in base64: the
// document is written once, by the admin (`planDocumentText`), and read as
// it is, so nothing is canonicalized on either side.

/** Where the plan and its signature are, in the connector's folder. */
export const planFiles = {
  plan: "plan.json",
  signature: "plan.json.sig",
} as const;

/** What the guard reads of a signed plan: whose, which round, its hosts. */
export const signedPlanSchema = z.object({
  app: connectorNameSchema,
  round: z.int().min(1),
  plan: z.looseObject({ hosts: z.array(hostSchema).min(1).max(16) }),
});
export type SignedPlan = z.infer<typeof signedPlanSchema>;

/** The text of plan document `document`, as it is signed and committed. */
export const planDocumentText = (document: {
  app: string;
  round: number;
  plan: unknown;
}): string =>
  `${JSON.stringify({ app: document.app, round: document.round, plan: document.plan }, null, 2)}\n`;

/** Bytes as standard base64. */
const toBase64 = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes));

/** Standard base64 as bytes; undefined for anything else. */
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(text)) {
    return undefined;
  }
  try {
    return Uint8Array.from(atob(text), (char) => char.codePointAt(0) ?? 0);
  } catch {
    return undefined;
  }
};

/**
 * Signs plan document `text` with `privateKey`, an Ed25519 key in PKCS #8,
 * base64: the signature, base64.
 */
export const signPlanText = async (
  privateKey: string,
  text: string
): Promise<string> => {
  const der = fromBase64(privateKey.trim());
  if (der === undefined) {
    throw new TypeError("The plan signing key isn't base64");
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "Ed25519" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    new TextEncoder().encode(text)
  );
  return toBase64(new Uint8Array(signature));
};

/**
 * Whether `signature` (base64) is the signature of plan document `text`
 * by the key whose public half is `publicKey`, the raw 32 bytes, base64.
 * False for anything malformed, never a throw.
 */
export const verifyPlanSignature = async (
  publicKey: string,
  text: string,
  signature: string
): Promise<boolean> => {
  const raw = fromBase64(publicKey.trim());
  const signed = fromBase64(signature.trim());
  if (raw?.length !== 32 || signed?.length !== 64) {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signed,
      new TextEncoder().encode(text)
    );
  } catch {
    return false;
  }
};
