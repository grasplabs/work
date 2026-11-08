import { isFileType, isPreviewable } from "@grasp-os/shared/app-file-limits";
import type { FileDescription } from "@grasp-os/shared/app-file-limits";
import { useEffect, useState, useSyncExternalStore } from "react";

import { clientInternals } from "../client-core.ts";
import type { GraspClient } from "../client-core.ts";
import { clientError } from "../client-error.ts";
import type { GraspError } from "../client-error.ts";
import { fileFailure } from "../client-files.ts";
import type { FileView, UploadOptions } from "../client-files.ts";
import type { FilesReference } from "../file-link-references.ts";
import { readFileRef } from "../file-references.ts";
import type { Declaring, FileRef } from "../file-references.ts";
import { UploadTransfer } from "../upload-transfer.ts";
import type { UploadView } from "../upload-transfer.ts";
import { useClient } from "./provider.ts";
import { noSubscription } from "./queries.ts";

/**
 * A local URL of `preview`, when the file it previews may be previewed
 * (a bounded raster image) and the preview is within that bound: typed
 * as the file was checked to be, whatever type the preview came with.
 */
const previewUrlOf = (
  description: FileDescription,
  preview: Blob | null
): string | null =>
  preview !== null &&
  isFileType(description.mimeType) &&
  isPreviewable(description.mimeType, preview.size)
    ? URL.createObjectURL(new Blob([preview], { type: description.mimeType }))
    : null;

/** What `useUpload` answers: its transfer's view, flat, and its two commands. */
type UploadHandle = UploadView & {
  /**
   * Uploads `file` through the resource, resolving with its reference once
   * core checked and published it. One at a time: another call while one
   * runs is refused (`file.upload_active`). Aborting `signal` cancels it.
   * Attach the reference to a record with a mutation of the App's; the
   * upload alone shows it to nobody else.
   */
  readonly upload: (file: File, options?: UploadOptions) => Promise<FileRef>;
  /**
   * Cancels the running upload, resolving once core acknowledged it: the
   * view is then cancelled, or completed when publication won.
   */
  readonly cancel: () => Promise<void>;
};

/**
 * An upload through `resource`, a files resource the App declares with
 * `upload` (spec 10.7.5): its view (idle, uploading, verifying, completed,
 * failed or cancelled; while uploading or verifying, `bytesUploaded` of
 * `bytesTotal`) and `upload` and `cancel`.
 *
 * ```tsx
 * const upload = useUpload(permissions.files);
 * const attach = useMutation(api.notes.attachFile);
 * // In a handler:
 * const file = await upload.upload(picked);
 * await attach({ id: note._id, expectedRevision: note._rev, file });
 * ```
 */
export const useUpload = <Reference extends FilesReference>(
  resource: Declaring<Reference, "upload">
): UploadHandle => {
  const client = useClient();
  // One transfer per client and resource: another of either starts with
  // a transfer of its own, never showing the last one's file or progress,
  // and the last one's upload still running is cancelled.
  const [held, setHeld] = useState(() => ({
    client,
    alias: resource.alias,
    transfer: new UploadTransfer(clientInternals(client)),
  }));
  let current = held;
  if (held.client !== client || held.alias !== resource.alias) {
    current = {
      client,
      alias: resource.alias,
      transfer: new UploadTransfer(clientInternals(client)),
    };
    setHeld(current);
  }
  const { transfer } = current;
  useEffect(
    () => () => {
      // Its failure is the transfer's own state, shown no more.
      const cancelling = async (): Promise<void> => {
        try {
          await transfer.cancel();
        } catch {
          // Nothing waits on it.
        }
      };
      void cancelling();
    },
    [transfer]
  );
  const view = useSyncExternalStore(transfer.subscribe, transfer.view);
  return {
    ...view,
    upload: async (file, options) =>
      await transfer.upload(client.files, resource, file, options),
    cancel: async () => {
      await transfer.cancel();
    },
  };
};

/**
 * What `useFile` last settled: for which client, resource and file, the
 * view, the failure, or that this client deleted it.
 */
interface ShownFile {
  readonly client: GraspClient;
  readonly key: string;
  readonly view?: FileView;
  readonly error?: GraspError;
  readonly gone?: true;
}

/**
 * The file `file` (or nothing, with `"skip"`) through `resource`, a files
 * resource the App declares with `read` (spec 10.7.5): `undefined` while
 * it loads or is skipped, then `{ file, name, mimeType, size, previewUrl }`.
 * A failure is thrown to the page's error boundary, as a query's is.
 *
 * `null` once the file was deleted through this client while shown, as a
 * query answers `null` for a document that is gone: its preview revoked,
 * nothing read again, and nothing thrown. A page that removes a file
 * still shows it until its own data catches up (the row a live query
 * lists until the change reaches it), so its deletion is no failure.
 *
 * `previewUrl` is a local URL of a bounded raster image's preview, for an
 * `<img>`, or null; it is revoked when another file is shown, the page
 * leaves or the person's access changes, and is never a URL to the file
 * elsewhere. When the person's access changes (a fence), the refusal is
 * shown, and nothing is read again until the page tries again.
 */
export const useFile = <Reference extends FilesReference>(
  resource: Declaring<Reference, "read">,
  file: FileRef | "skip"
): FileView | null | undefined => {
  const client = useClient();
  const internals = clientInternals(client);
  // What the view is of: the resource and the file, read by this client.
  // The resource as first given under its alias: an equal one made anew
  // each render (\`{ ...resources.photos }\`) never reads the file again.
  const [reading, setReading] = useState(resource);
  if (reading.alias !== resource.alias) {
    setReading(resource);
  }
  // A reference core could have minted, checked as download and delete
  // check theirs: anything else is refused here, never read as "skip".
  const id = file === "skip" ? undefined : readFileRef(file).id;
  const key = id === undefined ? undefined : `${resource.alias}/${id}`;
  // The fences as the hook's first render saw them: one between it and
  // the effect is caught by the effect, which never reads past it. After
  // a fence the page shows the refusal until it is mounted again.
  const [seen, setSeen] = useState(() => ({
    client,
    fences: internals.fences(),
  }));
  // Fences are each client's own: another client starts from its own.
  let fencesSeen = seen.fences;
  if (seen.client !== client) {
    fencesSeen = internals.fences();
    setSeen({ client, fences: fencesSeen });
  }
  const [shown, setShown] = useState<ShownFile>();
  useEffect(() => {
    if (id === undefined || key === undefined) {
      return noSubscription();
    }
    const stop = new AbortController();
    let previewUrl: string | null = null;
    const revoke = (): void => {
      if (previewUrl !== null) {
        URL.revokeObjectURL(previewUrl);
        previewUrl = null;
      }
    };
    // A refusal stays until the page is mounted again: a deletion that
    // finishes after it never turns it into the file gone.
    let refused = false;
    // Deleted through this client, once core recorded it: gone, never read
    // again (core's answer would be that it isn't there).
    const unwatch = internals.onFileDeleted((deleted) => {
      if (deleted === id && !refused) {
        stop.abort();
        revoke();
        setShown({ client, key, gone: true });
      }
    });
    const fenced = (): void => {
      refused = true;
      stop.abort();
      revoke();
      setShown({
        client,
        key,
        error: internals.fencedBy() ?? clientError("function.unreachable"),
      });
    };
    const unfence = internals.onFence(fenced);
    if (internals.fences() !== fencesSeen) {
      fenced();
      return () => {
        unwatch();
        unfence();
      };
    }
    // Deleted before this view asked for it (shown again after a skip,
    // say): gone (below), not read.
    if (internals.fileDeleted(id)) {
      return () => {
        unwatch();
        unfence();
      };
    }
    const read = async (): Promise<void> => {
      try {
        const { description, preview } = await client.files.read(
          reading,
          { id },
          stop.signal
        );
        if (stop.signal.aborted) {
          return;
        }
        previewUrl = previewUrlOf(description, preview);
        setShown({
          client,
          key,
          view: {
            file: { id: description.id },
            name: description.name,
            mimeType: description.mimeType,
            size: description.size,
            previewUrl,
          },
        });
      } catch (error) {
        if (!stop.signal.aborted) {
          setShown({ client, key, error: fileFailure(error) });
        }
      }
    };
    void read();
    return () => {
      unwatch();
      unfence();
      stop.abort();
      revoke();
      // What this read settled goes with it: its preview is revoked, so a
      // later read of the same file (after a skip, say) starts loading.
      setShown(undefined);
    };
  }, [client, internals, reading, id, key, fencesSeen]);
  // Shown only for what is asked now: another resource, file or client is
  // loading until its own read settles, or gone if this client deleted it.
  if (shown === undefined || shown.key !== key || shown.client !== client) {
    return id !== undefined && internals.fileDeleted(id) ? null : undefined;
  }
  if (shown.error !== undefined) {
    throw shown.error;
  }
  if (shown.gone === true) {
    return null;
  }
  return shown.view;
};
