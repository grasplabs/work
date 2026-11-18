import { failureText } from "@grasp-os/shared/errors";
import { pageMaxLimit } from "@grasp-os/shared/knowledge";
import {
  uploadMaxBytes,
  uploadOriginalPath,
  uploadTypes,
} from "@grasp-os/shared/uploads";
import type { Upload, UploadStatus } from "@grasp-os/shared/uploads";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";

import { readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { isTransient, wait } from "../core.ts";
import { FileUpload } from "../grasp/file-upload/index.ts";
import type { FileUploadStatus } from "../grasp/file-upload/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { Download } from "../grasp/icons/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCore } from "../use-core.ts";

// Uploading a file into a collection, and following it, in the library's
// file upload: it sends each file as it is dropped or chosen, and its row
// then says what core does with it. Core answers at once with the upload `pending`, and extracts its text in the background,
// so the page asks again, less often the longer it takes, until it's
// ready (a version of the document at the file's name, with a link to its
// original) or failed, with core's reason. Only the person who uploaded a
// file can follow it, and only while this page stays open: leaving it
// stops the asking. Once ready, the row opens its document and downloads
// its original.

/** How long to wait before asking again, each time; the last one repeats. */
const followDelaysMs = [500, 1000, 2000, 3000] as const;

/**
 * How long to follow one upload before leaving it: an extraction that
 * keeps failing for a moment retries for a few minutes before it fails.
 */
const followForMs = 10 * 60 * 1000;

const settled = ({ status }: Upload): boolean =>
  status === "ready" || status === "failed";

interface Followed {
  upload: Upload;
  /** Why the page stopped following it before it settled. */
  problem?: string;
  /** Core refused to say: the problem is a failure, not a wait. */
  refused?: boolean;
}

/**
 * Asks core for `upload` until it has settled, for `followForMs` at most,
 * or until `following` says to stop, telling `onChange` each time it
 * answers. Core out of reach for a moment only costs a turn; a refusal
 * ends it, with core's reason.
 */
const follow = async (
  core: CoreConnection,
  upload: Upload,
  onChange: (upload: Upload) => void,
  following: () => boolean
): Promise<Followed> => {
  const until = Date.now() + followForMs;
  let current = upload;
  let turn = 0;
  while (!settled(current) && Date.now() < until && following()) {
    const delay =
      followDelaysMs[Math.min(turn, followDelaysMs.length - 1)] ?? 0;
    // oxlint-disable-next-line no-await-in-loop -- backing off between asks
    await wait(delay);
    turn += 1;
    // The page may have closed while waiting: then nobody asks.
    if (!following()) {
      break;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- one ask at a time
      current = await readWithin(
        core,
        async (session) => await session.uploads.get(upload.id)
      );
      onChange(current);
    } catch (error) {
      if (!isTransient(error)) {
        return { upload: current, problem: failureText(error), refused: true };
      }
    }
  }
  return settled(current)
    ? { upload: current }
    : {
        upload: current,
        problem: i18n._(
          msg`Still being read. It shows in the file list once it's ready.`
        ),
      };
};

const statusLabels: Readonly<Record<UploadStatus, MessageDescriptor>> = {
  pending: msg`Pending`,
  extracting: msg`Extracting`,
  ready: msg`Ready`,
  failed: msg`Failed`,
};

/**
 * A sent file, as this page knows it: core's upload, followed until it
 * settles, or why it never reached core.
 */
type Tracked = Followed | { problem: string };

/**
 * Sends `file` into the collection: the upload core started, or why it
 * didn't. Outside the component, as the React Compiler can't compile
 * `try`/`catch` around a value it returns.
 */
const sendFile = async (
  core: CoreConnection,
  collectionId: string,
  file: File
): Promise<{ started: Upload } | { problem: string }> => {
  try {
    const started = await core.withSession(async (session) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return await session.uploads.upload({
        collectionId,
        name: file.name,
        bytes,
      });
    });
    return { started };
  } catch (error) {
    return { problem: failureText(error) };
  }
};

/** The words a file's row says once it is sent. */
interface RowWords {
  /** A ready document past the first page of the file list. */
  past: string;
}

/**
 * What the row of a sent file says: core's reason when it never got
 * there, the following's problem, else the upload's status (with core's
 * reason when its reading failed). `listed` holds the documents the file
 * list shows.
 */
const statusOf = (
  tracked: Tracked | undefined,
  listed: ReadonlySet<string>,
  words: RowWords
): FileUploadStatus | undefined => {
  if (tracked === undefined) {
    return undefined;
  }
  if (!("upload" in tracked)) {
    return { line: tracked.problem, tone: "danger" };
  }
  const { upload, problem, refused } = tracked;
  if (problem !== undefined) {
    return { line: problem, tone: refused === true ? "danger" : "neutral" };
  }
  const status = i18n._(statusLabels[upload.status]);
  if (upload.status === "failed") {
    const line =
      upload.failure === null ? status : `${status}: ${upload.failure.message}`;
    return { line, tone: "danger" };
  }
  if (upload.status !== "ready") {
    return { line: status, working: true };
  }
  // The file list shows its first page only: a name that sorts past it
  // opens from here.
  const past = upload.documentId !== null && !listed.has(upload.documentId);
  return { line: past ? words.past : status };
};

/** The document a sent file made, once it's ready; null before. */
const readyOf = (
  tracked: Tracked | undefined
): { upload: Upload; documentId: string } | null => {
  const upload =
    tracked !== undefined && "upload" in tracked ? tracked.upload : undefined;
  if (upload?.status !== "ready" || upload.documentId === null) {
    return null;
  }
  return { upload, documentId: upload.documentId };
};

const styles = stylex.create({
  section: { display: "flex", flexDirection: "column", gap: grasp.space2 },
});

/**
 * Uploading files into the collection `collectionId`, and their status,
 * in the one list of the file upload; `listed` holds the documents the
 * file list shows.
 */
export const Uploads = ({
  collectionId,
  listed,
}: {
  collectionId: string;
  listed: ReadonlySet<string>;
}) => {
  const router = useRouter();
  const navigate = useNavigate();
  const headingId = useId();
  const core = useCore();
  const [tracked, setTracked] = useState<ReadonlyMap<File, Tracked>>(new Map());
  const { t } = useLingui();
  // Whether the page is still open: nobody sees the status once it isn't.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const set = (file: File, entry: Tracked): void => {
    setTracked((all) => new Map(all).set(file, entry));
  };
  const track = async (file: File, started: Upload): Promise<void> => {
    const end = await follow(
      core,
      started,
      (news) => {
        set(file, { upload: news });
      },
      () => open.current
    );
    if (!open.current) {
      return;
    }
    set(file, end);
    if (end.upload.status === "ready") {
      // The file list shows the new document, or its new version.
      await router.invalidate({ sync: true });
    }
  };
  // Sends one file, File upload showing it on its way; several can be on
  // their way at once. Core's refusal shows on its row, in core's words.
  const send = async (file: File): Promise<void> => {
    const sent = await sendFile(core, collectionId, file);
    if ("problem" in sent) {
      set(file, { problem: sent.problem });
      return;
    }
    set(file, { upload: sent.started });
    void track(file, sent.started);
  };
  const words: RowWords = {
    past: t`Ready. It's past the first ${pageMaxLimit} files listed: open it from here.`,
  };
  const accept = Object.keys(uploadTypes).map((extension) => `.${extension}`);
  return (
    <section aria-labelledby={headingId} {...stylex.props(styles.section)}>
      <Heading id={headingId} level={2} size="ui-sm">
        {t`Upload`}
      </Heading>
      <FileUpload
        accept={accept}
        actions={(file) => {
          const ready = readyOf(tracked.get(file));
          if (ready === null) {
            return [];
          }
          const { upload, documentId } = ready;
          const { name } = upload;
          return [
            {
              label: t`Open ${name}`,
              onAction: () => {
                void navigate({
                  to: "/knowledge/$collection",
                  params: { collection: upload.collectionId },
                  search: { doc: documentId },
                });
              },
            },
            // Core serves it as an attachment only, to those who may read it.
            {
              label: t`Download ${name}`,
              icon: Download,
              href: uploadOriginalPath(encodeURIComponent(upload.id)),
            },
          ];
        }}
        hint={t`Upload a PDF, Word or Excel file, or captions (.vtt)`}
        maxSize={uploadMaxBytes}
        multiple
        status={(file) => statusOf(tracked.get(file), listed, words)}
        upload={send}
      />
      <Text size="xs" tone="muted">
        {t`Don’t upload interview recordings or their captions: interviews go through the interview flow.`}
      </Text>
    </section>
  );
};
