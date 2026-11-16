import { actorOf, delegateActorOf } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import type { PermissionId } from "@grasp-os/shared/ids";
import type { Authority } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";

import type { WorkContext } from "../restricted.ts";

// Who acts on today's Brain through core's ports (ports.ts). Core reads
// nothing of it any more (GRA-1938): what still runs, until the Knowledge
// database goes, writes and erases, and names who did it.

/**
 * Who acts on Knowledge: a signed-in person, or an App or agent acting
 * for one in a chat or App. `permissionId` limits an App or agent to that
 * one permission: its stub's.
 */
export type Reader =
  | { type: "person"; person: Identity }
  | {
      type: "delegate";
      authority: Authority;
      context: WorkContext;
      permissionId?: PermissionId;
    };

/** Who acted, as the audit log names them. */
export const readerActor = (reader: Reader): AuditActor =>
  reader.type === "person"
    ? actorOf(reader.person)
    : delegateActorOf(reader.authority);
