import { toBase64Url } from "@grasp-os/shared/encoding";

import { derivedHmacKey } from "../derived-keys.ts";

// Each person's link secret is made from a random id the store keeps for
// them and core's own key: the store can give the link again (to the
// admin's list, to the email that sends it) without keeping the secret
// anywhere, and what it keeps, the id and the secret's hash, opens nothing
// on its own. Rotating the auth secret stops every link that went out
// (the hashes kept no longer match), so it waits until the interviews
// are over.

const linkPurpose = "grasp-os onboarding link";

/** The secret of the link made from `linkId`: 32 bytes, base64url. */
export const linkSecretOf = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  linkId: string
): Promise<string> => {
  const key = await derivedHmacKey(env, linkPurpose, ["sign"]);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(linkId)
  );
  return toBase64Url(new Uint8Array(mac));
};
