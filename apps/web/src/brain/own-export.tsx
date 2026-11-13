import { Button } from "@grasp-os/ui/components/button";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";

import { useCoreRead } from "../apps/use-core-read.ts";
import { ErrorText } from "../error-text.tsx";
import { useKeyedAction } from "./own-export-action.ts";
import {
  ownExportFileHref,
  readOwnExport,
  startOwnExport,
} from "./own-export-route.ts";
import type { OwnExport } from "./own-export-route.ts";

// Brain › Sources: the person's own export of what only they may read
// (GRA-1839). Their own store writes it on its own alarm, a part a minute
// or so, so while it is written the page reads it again every few seconds,
// as the erasures page follows an erasure (settings/erasures.tsx), until
// it is done. What is shown is always the latest read: a start is followed
// by a read, never by what the start answered. Each file is a plain link
// the browser downloads on the person's session (core's route checks it).

/** How often the page reads the export again while it is written. */
export const followEveryMs = 5000;

/** What the person can do with their export: none, or one that ended without files. */
const StartButton = ({
  busy,
  again,
  onStart,
}: {
  busy: boolean;
  again: boolean;
  onStart: () => void;
}) => (
  <div>
    <Button disabled={busy} onClick={onStart} variant="outline">
      {again ? <Trans>Export again</Trans> : <Trans>Export</Trans>}
    </Button>
  </div>
);

/** A done export: its files, each a download, or that it holds nothing. */
const Files = ({ shown }: { shown: OwnExport }) => {
  const { t } = useLingui();
  // The manifest alone: no part, so nothing only they may read was kept.
  const empty = shown.files.length <= 1;
  return (
    <>
      <p className="text-sm">
        {empty ? (
          <Trans>
            The Brain keeps nothing that only you may read yet, so your export
            holds nothing.
          </Trans>
        ) : (
          <Trans>Your export is ready. Download each of its files:</Trans>
        )}
      </p>
      <ul aria-label={t`Your export's files`} className="flex flex-col gap-1">
        {shown.files.map((file) => (
          <li key={file}>
            <Button
              nativeButton={false}
              render={
                <a download href={ownExportFileHref(shown.id, file)}>
                  {file}
                </a>
              }
              size="inline"
              variant="link"
            />
          </li>
        ))}
      </ul>
    </>
  );
};

/** Where the person's own export is, and what they can do about it. */
export const OwnExportSection = () => {
  const { t } = useLingui();
  const heading = useId();
  const [reads, setReads] = useState(0);
  const read = useCoreRead(
    `own-export/${reads}`,
    async () => await readOwnExport(),
    "own-export"
  );
  const shown = read?.state === "ready" ? read.data : undefined;
  const writing = shown?.state === "writing";
  const readAgain = (): void => {
    setReads((before) => before + 1);
  };
  // While it is written, read again until it isn't.
  useEffect(() => {
    const timer = writing
      ? setInterval(() => {
          setReads((before) => before + 1);
        }, followEveryMs)
      : undefined;
    return () => {
      clearInterval(timer);
    };
  }, [writing]);
  const { busy, failure, run } = useKeyedAction("own-export");
  const start = (): void => {
    void run(async () => {
      await startOwnExport(t`Grasp couldn’t start your export just now.`);
    }, readAgain);
  };

  let body: ReactNode;
  if (read === undefined) {
    body = <Spinner aria-label={t`Reading where your export is`} />;
  } else if (read.state !== "ready") {
    body = (
      <>
        <ErrorText>
          {read.state === "refused"
            ? read.message
            : t`Grasp can’t be reached just now.`}
        </ErrorText>
        <div>
          <Button onClick={readAgain} variant="outline">
            <Trans>Try again</Trans>
          </Button>
        </div>
      </>
    );
  } else if (shown?.state === "writing") {
    body = (
      <output className="flex items-center gap-2">
        <Spinner aria-hidden />
        <p className="text-sm">
          <Trans>
            Grasp is writing your export. It takes a minute or two; it shows
            here as soon as it is ready, and you can leave this page meanwhile.
          </Trans>
        </p>
      </output>
    );
  } else if (shown?.state === "done") {
    body = (
      <>
        <Files shown={shown} />
        <StartButton again busy={busy} onStart={start} />
      </>
    );
  } else if (shown?.state === "erased") {
    body = (
      <>
        <p className="text-sm">
          <Trans>
            Something your export held was erased since, so the export was
            deleted with it. Make a new one.
          </Trans>
        </p>
        <StartButton again busy={busy} onStart={start} />
      </>
    );
  } else if (shown?.state === "failed") {
    body = (
      <>
        <p className="text-sm">
          <Trans>Your export couldn’t be finished. Try making it again.</Trans>
        </p>
        <StartButton again busy={busy} onStart={start} />
      </>
    );
  } else {
    // None yet (or one replaced since, which a person's store never shows).
    body = <StartButton again={false} busy={busy} onStart={start} />;
  }

  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3">
      <h2 className="text-sm font-medium" id={heading}>
        <Trans>Export what only you may read</Trans>
      </h2>
      <p className="text-muted-foreground text-sm">
        <Trans>
          A copy of everything the Brain keeps for you alone: your own sources
          and what it remembers from them. Only you can make it and download it,
          and it is deleted when you are erased.
        </Trans>
      </p>
      {body}
      {/* A start that failed, unless the read since shows it started after all. */}
      {writing ? null : <ErrorText>{failure}</ErrorText>}
    </section>
  );
};
