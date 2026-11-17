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
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";

import { readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { isTransient, wait } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { Button } from "../grasp/button/index.ts";
import { FileUpload } from "../grasp/file-upload/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { Download, Failed, File as FileMark } from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCore } from "../use-core.ts";

// Uploading a file into a collection, and following it: the library's file
// upload sends each file as it is dropped or chosen, and says how the
// sending went; core answers at
// once with the upload `pending`, and extracts its text in the background,
// so the page asks again, less often the longer it takes, until it's
// ready (a version of the document at the file's name, with a link to its
// original) or failed, with core's reason. Only the person who uploaded a
// file can follow it, and only while this page stays open: leaving it
// stops the asking.

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
        return { upload: current, problem: failureText(error) };
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

/** Why a file didn't reach core, in core's words. */
interface Refused {
  file: File;
  problem: string;
}

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

const styles = stylex.create({
  section: { display: "flex", flexDirection: "column", gap: grasp.space2 },
});

/**
 * One upload: its status, and once ready, links to its document and its
 * original. `listed` holds the documents the file list shows.
 */
const UploadRow = ({
  upload,
  problem,
  listed,
}: Followed & { listed: ReadonlySet<string> }) => {
  const { t } = useLingui();
  const { name, documentId } = upload;
  const status = i18n._(statusLabels[upload.status]);
  // The document it made, once it's ready.
  const opens = upload.status === "ready" ? documentId : null;
  // The file list shows its first page only: a name that sorts past it
  // opens from here.
  const past = opens !== null && !listed.has(opens);
  return (
    <Item size="sm" variant="outline">
      <ItemMedia icon={upload.status === "failed" ? Failed : FileMark} />
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        <ItemDescription>
          <output>
            {upload.failure === null
              ? status
              : `${status}: ${upload.failure.message}`}
          </output>
        </ItemDescription>
        {past ? (
          <ItemDescription>
            {t`It's past the first ${pageMaxLimit} files listed: open it from here.`}
          </ItemDescription>
        ) : null}
        <ErrorText>{problem}</ErrorText>
      </ItemContent>
      {opens === null ? null : (
        <ItemActions>
          <Button
            render={
              <Link
                params={{ collection: upload.collectionId }}
                search={{ doc: opens }}
                to="/knowledge/$collection"
              />
            }
            size="sm"
            variant="ghost"
          >
            {t`Open ${name}`}
          </Button>
          {/* Core serves it as an attachment only, to those who may read it. */}
          <Button
            aria-label={t`Download ${name}`}
            icon={Download}
            render={
              <a
                aria-label={t`Download ${name}`}
                download
                href={uploadOriginalPath(encodeURIComponent(upload.id))}
              />
            }
            size="sm"
            variant="ghost"
          />
        </ItemActions>
      )}
    </Item>
  );
};

/** A file that didn't reach core: its name, and core's reason. */
const RefusedRow = ({ file, problem }: Refused) => (
  <Item size="sm" variant="outline">
    <ItemMedia icon={Failed} />
    <ItemContent>
      <ItemTitle>{file.name}</ItemTitle>
      <ErrorText>{problem}</ErrorText>
    </ItemContent>
  </Item>
);

/**
 * Uploading files into the collection `collectionId`, and their status;
 * `listed` holds the documents the file list shows.
 */
export const Uploads = ({
  collectionId,
  listed,
}: {
  collectionId: string;
  listed: ReadonlySet<string>;
}) => {
  const router = useRouter();
  const headingId = useId();
  const core = useCore();
  const [refused, setRefused] = useState<Refused[]>([]);
  const [followed, setFollowed] = useState<Followed[]>([]);
  const { t } = useLingui();
  // Whether the page is still open: nobody sees the status once it isn't.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const update = ({ upload, problem }: Followed): void => {
    setFollowed((all) =>
      all.map((entry) =>
        entry.upload.id === upload.id ? { upload, problem } : entry
      )
    );
  };
  const track = async (started: Upload): Promise<void> => {
    const end = await follow(
      core,
      started,
      (news) => {
        update({ upload: news });
      },
      () => open.current
    );
    if (!open.current) {
      return;
    }
    update(end);
    if (end.upload.status === "ready") {
      // The file list shows the new document, or its new version.
      await router.invalidate({ sync: true });
    }
  };
  // Sends one file; File upload shows it on its way, and Try again sends it
  // again. A refusal throws, so its row says it failed, and core's reason
  // shows below. Several can be on their way at once.
  const send = async (file: File): Promise<void> => {
    setRefused((all) => all.filter((entry) => entry.file !== file));
    const sent = await sendFile(core, collectionId, file);
    if ("problem" in sent) {
      const { problem } = sent;
      setRefused((all) => [{ file, problem }, ...all]);
      throw new Error(problem);
    }
    setFollowed((all) => [{ upload: sent.started }, ...all]);
    void track(sent.started);
  };
  const accept = Object.keys(uploadTypes).map((extension) => `.${extension}`);
  return (
    <section aria-labelledby={headingId} {...stylex.props(styles.section)}>
      <Heading id={headingId} level={2} size="ui-sm">
        {t`Upload`}
      </Heading>
      <FileUpload
        accept={accept}
        hint={t`Upload a PDF, Word or Excel file, or captions (.vtt)`}
        maxSize={uploadMaxBytes}
        multiple
        upload={send}
      />
      <Text size="xs" tone="muted">
        {t`Don’t upload interview recordings or their captions: interviews go through the interview flow.`}
      </Text>
      {refused.length === 0 && followed.length === 0 ? null : (
        <ItemGroup>
          {refused.map((entry) => (
            <RefusedRow
              file={entry.file}
              key={`${entry.file.name}-${entry.file.lastModified}`}
              problem={entry.problem}
            />
          ))}
          {followed.map((entry) => (
            <UploadRow key={entry.upload.id} listed={listed} {...entry} />
          ))}
        </ItemGroup>
      )}
    </section>
  );
};
