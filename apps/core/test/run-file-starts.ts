import { sha256HexOfBytes } from "@grasp-os/shared/encoding";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";

import { outboxedWhere } from "../src/audit-outbox.ts";
import type { StartFile, StartFiles } from "../src/workflows/start-files.ts";

// A run's own files, as a start hands them (workflows/start-files.ts):
// the way a run comes to hold a finished file, for tests of what follows
// (its downloads, its sweep). Each file's bytes are put in R2 chunk by
// chunk, as an App's store records them, and copied into the run as its
// start is admitted.

/** A file a test's start hands its run: its name, type and bytes, chunk by chunk. */
export interface HandedFile {
  readonly name: string;
  readonly type: string;
  readonly chunks: readonly Uint8Array[];
}

/**
 * `file` as a start may hand it, by its ID: what `startWorkflow` takes as
 * its `files`, for a start whose input names it as `{ id }`.
 */
export const startFilesOf = async (
  file: HandedFile
): Promise<{ readonly id: string; readonly files: StartFiles }> => {
  const chunks = await Promise.all(
    file.chunks.map(async (bytes) => {
      const key = `app-files/test/${crypto.randomUUID()}`;
      await env.FILES.put(key, bytes);
      return { key, sha256: await sha256HexOfBytes(bytes) };
    })
  );
  const handed: StartFile = {
    id: crypto.randomUUID(),
    name: file.name,
    type: file.type,
    size: file.chunks.reduce((sum, bytes) => sum + bytes.byteLength, 0),
    chunks,
  };
  return {
    id: handed.id,
    files: {
      read: async (id) => {
        if (id !== handed.id) {
          throw new Error("file.not_found");
        }
        return await Promise.resolve(handed);
      },
      // Audited as an App's start audits the file it hands, by no one.
      sent: (sent, run, workflow, admitted) =>
        outboxedWhere(
          drizzle(env.DB),
          {
            actor: { type: "system" },
            action: "file.sent_to_run",
            target: { type: "file", id: sent.id },
            detail: { workflow, run },
          },
          admitted
        ),
    },
  };
};
