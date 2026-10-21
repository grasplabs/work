import { schemaHash } from "@grasp-os/sdk/host";
import { fileErrors } from "@grasp-os/shared/app-files";
import type { AppId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { drizzle } from "drizzle-orm/d1";

import { operationRoles } from "./app-access.ts";
import type { Release } from "./app-releases.ts";
import { outboxedWhere } from "./audit-outbox.ts";
import { storeFiles } from "./data-stores.ts";
import type { StartFiles } from "./workflows/start-files.ts";

// The App files a screen's start may hand its run (GRA-885): those of the
// App's own store, each read as the person using the screen may read it
// now, with their roles in the App now and its release's schema, through
// a files resource the release declares with `read`, as the screen's own
// download of it would be (app-file-route.ts). Anything else, a file
// still uploading, another person's unattached upload or a record they no
// longer see, answers `file.not_found`, the same however it isn't theirs.

/**
 * The App files `by`'s start through App `app`'s screen may hand its run,
 * under `release`: none an App without a store keeps.
 */
export const screenStartFiles = (
  env: Env,
  by: Pick<Identity, "userId" | "role">,
  app: AppId,
  release: Release
): StartFiles => {
  const readable = Object.entries(release.app.browserResources).flatMap(
    ([alias, declared]) =>
      declared["~resource"] === "files" && declared.operations.includes("read")
        ? [alias]
        : []
  );
  const { store } = release;
  return {
    read: async (fileId) => {
      if (store === null || readable.length === 0) {
        throw fileErrors.create("file.not_found");
      }
      const { storeId, stub } = await storeFiles(env, store.storeId);
      const content = await stub.fileReadableThrough(
        storeId,
        {
          principal: by.userId,
          roles: await operationRoles(env, by, app),
          schemaHash: await schemaHash(release.app.schema),
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
    // statement of the admitting batch, never run on its own.
    sent: (file, runId, workflowId, admitted) =>
      outboxedWhere(
        drizzle(env.DB),
        {
          actor: { type: "person", userId: by.userId },
          action: "file.sent_to_run",
          target: { type: "file", id: file.id },
          detail: {
            app,
            store: store?.storeId ?? "",
            workflow: workflowId,
            run: runId,
            uploadedBy: file.ownerId,
          },
        },
        admitted
      ),
  };
};
