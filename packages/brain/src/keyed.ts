import type { Brain } from "./brain.ts";
import { toHex } from "./encoding.ts";
import { canonicalJson } from "./json.ts";
import type { Json } from "./json.ts";

/** `parts` keyed to this deployment: never computable from them alone. */
export const keyed = async <C>(
  brain: Brain<C>,
  purpose: string,
  parts: Json
): Promise<string> => {
  const key = await brain.ports.keys.hmac(purpose, ["sign"]);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonicalJson(parts))
  );
  return toHex(new Uint8Array(mac));
};
