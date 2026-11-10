import type { AnyPermission } from "@grasp-os/runtime/app";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { jsonOf } from "@grasp-os/shared/operations";

/**
 * A permission declaration's SHA-256, as a release seals it: what an
 * approved binding pins (resource-bindings.ts).
 */
export const declarationHash = async (
  declaration: AnyPermission
): Promise<string> => {
  const json = jsonOf(declaration);
  if (json === undefined) {
    throw new Error("A permission declaration is JSON");
  }
  return await sha256Hex(canonicalJson(json));
};
