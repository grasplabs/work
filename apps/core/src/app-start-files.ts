import { schemaHash } from "@grasp-os/sdk/host";
import { fileErrors } from "@grasp-os/shared/app-files";
import type { AppId } from "@grasp-os/shared/ids";
import { drizzle } from "drizzle-orm/d1";

import { operationRoles } from "./app-access.ts";
import type { Release } from "./app-releases.ts";
import { outboxedWhere } from "./audit-outbox.ts";
import { memberRole } from "./auth/identity.ts";
import { storeFiles } from "./data-stores.ts";
import type { StartFiles } from "./workflows/start-files.ts";

// The App files an App's start may hand its run: a screen's start
// (GRA-885) and its server code's, an action's made as it runs and a
// commit's dispatched later (GRA-976). Those of the App's own store, each
// read as the person the start acts for may read it at the moment it is
// read: their organization role and their roles in the App read again
// then, never taken from the call, under the release of the App version
// whose code made the start, through a files resource that release
// declares with `read`, as the screen's own download of it would be
// (app-file-route.ts). Anything else, a file still uploading, another
// person's unattached upload, a record they no longer see or a person no
// longer a member, answers `file.not_found`, the same however it isn't
// theirs.

/**
 * The App files a start acting for `principal` through App `app` may hand
 * its run, under `release` (the release of the App version whose screen
 * or code made the start): none an App without a store keeps.
 */
export const appStartFiles = (
  env: Env,
  principal: string,
  app: AppId,
  /** The release, loaded only once a start holds a file. */
  release: Release | (() => Promise<Release>)
): StartFiles => {
  let loaded = typeof release === "function" ? undefined : release;
  const releaseOf = async (): Promise<Release> => {
    loaded ??= typeof release === "function" ? await release() : release;
    return loaded;
  };
  return {
    read: async (fileId) => {
      const { app: declared, store } = await releaseOf();
      const readable = Object.entries(declared.browserResources).flatMap(
        ([alias, resource]) =>
          resource["~resource"] === "files" &&
          resource.operations.includes("read")
            ? [alias]
            : []
      );
      if (store === null || readable.length === 0) {
        throw fileErrors.create("file.not_found");
      }
      // Who they are now: a person removed since the call reads nothing.
      const role = await memberRole(env.DB, principal);
      if (role === undefined) {
        throw fileErrors.create("file.not_found");
      }
      const { storeId, stub } = await storeFiles(env, store.storeId);
      const content = await stub.fileReadableThrough(
        storeId,
        {
          principal,
          roles: await operationRoles(env, { userId: principal, role }, app),
          schemaHash: await schemaHash(declared.schema),
        },
        fileId,
        readable
      );
      return {
        id: content.id,
        name: content.name,
        type: content.mimeType,
        size: content.size,
        ownerId: content.ownerId,
        chunks: content.chunks.map(({ key, sha256 }) => ({ key, sha256 })),
      };
    },
    // Each copy is a disclosure into a run, never folded into another. A
    // statement of the admitting batch, never run on its own: asked only
    // once its file was read, so its release is loaded.
    sent: (file, runId, workflowId, admitted) =>
      outboxedWhere(
        drizzle(env.DB),
        {
          actor: { type: "person", userId: principal },
          action: "file.sent_to_run",
          target: { type: "file", id: file.id },
          detail: {
            app,
            store: loaded?.store?.storeId ?? "",
            workflow: workflowId,
            run: runId,
            uploadedBy: file.ownerId,
          },
        },
        admitted
      ),
  };
};
