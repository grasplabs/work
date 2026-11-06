/**
 * A Worker of its own that `workerd test` runs, bundled and minified as
 * core is (scripts/workerd-minified-checks.ts): a real RPC target's method
 * is called as a staff member's session would call it, and the view its
 * session check would audit (`staffViewOf`, src/staff-audit.ts) must name
 * the target's surface by its class (`namespaceOf`) and the ID its
 * parameter is named for. A bundle that renamed the class or lost the
 * parameter's name would audit the view under another surface, or with no
 * ID, silently.
 */
import type { Identity } from "@grasp-os/shared/rpc";

import { currentCall } from "./src/call-context.ts";
import { KnowledgeRpc } from "./src/knowledge/rpc.ts";
import { staffViewOf } from "./src/staff-audit.ts";
import type { StaffView } from "./src/staff-audit.ts";

const documentId = "ent_00000000-0000-4000-8000-000000000001";

/** What a staff member's view of one document's backlinks is audited as. */
const expected: StaffView = {
  surface: "knowledge.backlinks",
  args: 2,
  kinds: ["documentId", "options"],
  ids: [documentId],
};

export default {
  async test(_controller: unknown, env: Env): Promise<void> {
    let viewed: StaffView | undefined;
    // The session check every method asks first: it reads the view, as
    // the audit does, and stops the method there.
    const check = async (): Promise<Identity> => {
      viewed = staffViewOf(currentCall());
      return await Promise.reject(new Error("Read as the audit reads it"));
    };
    await new KnowledgeRpc(env, check)
      .backlinks(documentId, { limit: 1 })
      .catch(() => null);
    if (JSON.stringify(viewed) !== JSON.stringify(expected)) {
      throw new Error(
        `A staff view of the minified bundle is audited as ${JSON.stringify(viewed)}, not ${JSON.stringify(expected)}`
      );
    }
  },
};
