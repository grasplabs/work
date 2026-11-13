import { Button } from "@grasp-os/ui/components/button";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useCoreRead } from "../apps/use-core-read.ts";
import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import {
  ownExportFileHref,
  readOwnExport,
  startOwnExport,
} from "./own-export-route.ts";
import type { OwnExport } from "./own-export-route.ts";

// Brain › Sources: the person's own export of what only they may read
// (GRA-1839). Their own store writes it on its own alarm, a part a minute
// or so. While it is written the page reads it again a few seconds after
// each read has landed, never over one still under way, and not while the
// page is hidden: once when it is seen again. What is shown is always the
// latest read: a start is followed by a read (`changeThenRefresh`), its
// button off until that read is back, and a start's failure is said only
// while the read on screen is the one that followed it. Each file is a
// plain link the browser downloads on the person's session (core's route
// checks it).

/** How long after a read has landed the page reads again, while it is written. */
export const followEveryMs = 5000;

/** How often the page was seen again after it was hidden: each is one more read. */
const useSeenAgain = (): number => {
  const [seen, setSeen] = useState(0);
  useEffect(() => {
    const back = (): void => {
      if (document.visibilityState === "visible") {
        setSeen((before) => before + 1);
      }
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
    };
  }, []);
  return seen;
};

/** A done export's files, each a download. */
const Files = ({ shown }: { shown: OwnExport }) => {
  const { t } = useLingui();
  return (
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
  );
};

/** What the section says of the latest read: announced as it changes. */
const Said = ({
  read,
  shown,
}: {
  read: Loaded<OwnExport | null> | undefined;
  shown: OwnExport | null | undefined;
}) => {
  if (read === undefined) {
    return <Trans>Checking on your export…</Trans>;
  }
  if (shown?.state === "writing") {
    return (
      <span className="flex items-center gap-2">
        <Spinner aria-hidden />
        <Trans>
          Grasp is writing your export. It takes a minute or two; it shows here
          as soon as it is ready, and you can leave this page meanwhile.
        </Trans>
      </span>
    );
  }
  if (shown?.state === "done") {
    return shown.files.length <= 1 ? (
      <Trans>
        The Brain keeps nothing that only you may read yet, so your export holds
        nothing.
      </Trans>
    ) : (
      <Trans>Your export is ready. Download each of its files:</Trans>
    );
  }
  if (shown?.state === "erased") {
    return (
      <Trans>
        Something your export held was erased since, so the export was deleted
        with it. Make a new one.
      </Trans>
    );
  }
  if (shown?.state === "failed") {
    return (
      <Trans>Your export couldn’t be finished. Try making it again.</Trans>
    );
  }
  return null;
};

/** Where the person's own export is, and what they can do about it. */
export const OwnExportSection = () => {
  const { t } = useLingui();
  const heading = useId();
  const status = useRef<HTMLOutputElement>(null);
  const [reads, setReads] = useState(0);
  const seenAgain = useSeenAgain();
  const read = useCoreRead(
    `own-export/${reads}/${seenAgain}`,
    async (_session, signal) => await readOwnExport(signal),
    "own-export"
  );
  const shown = read?.state === "ready" ? read.data : undefined;
  const writing = shown?.state === "writing";

  // Each read that lands (a new one: `useCoreRead` keeps the last while
  // the next is under way) lets a start's follow-up read go on, and, while
  // the export is written and the page seen, sets the next read a few
  // seconds on. One read at a time: none starts over one under way. A read
  // that failed (core out of reach, or slower than a read's deadline, as
  // every read of the app) is followed too, while the last that landed
  // showed the export being written.
  const landed = useRef<(() => void) | null>(null);
  const lastWriting = useRef(false);
  useEffect(() => {
    if (read !== undefined) {
      landed.current?.();
      landed.current = null;
    }
    if (read?.state === "ready") {
      lastWriting.current = writing;
    }
    const following =
      read !== undefined &&
      (writing || (read.state !== "ready" && lastWriting.current));
    const timer = following
      ? setTimeout(() => {
          if (document.visibilityState === "visible") {
            setReads((before) => before + 1);
          }
        }, followEveryMs)
      : undefined;
    return () => {
      clearTimeout(timer);
    };
  }, [read, writing]);
  // A follow-up read the page left before it landed holds up nothing.
  useEffect(
    () => () => {
      landed.current?.();
    },
    []
  );
  const readAgain = async (): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<true>();
    landed.current = () => {
      resolve(true);
    };
    setReads((before) => before + 1);
    await promise;
  };

  const { busy, run } = useCoreAction();
  /** Two clicks in one tick, before `busy` turns the button off: one start. */
  const starting = useRef(false);
  /** A start's failure, with the read on screen when it was said. */
  const [failed, setFailed] = useState<{
    reason: string;
    after: Loaded<OwnExport | null> | undefined;
  }>();
  /** The read on screen now, for a failure said after an await. */
  const onScreen = useRef(read);
  useEffect(() => {
    onScreen.current = read;
  }, [read]);
  const start = async (): Promise<void> => {
    if (starting.current) {
      return;
    }
    starting.current = true;
    setFailed(undefined);
    await run(
      async () => {
        await changeThenRefresh(startOwnExport, readAgain);
      },
      (reason) => {
        setFailed({ reason, after: onScreen.current });
      }
    );
    starting.current = false;
    // The button the person pressed is gone or replaced: their focus goes
    // to what the section now says, not to the top of the page.
    const section = status.current?.closest("section");
    if (section?.contains(document.activeElement) !== true) {
      status.current?.focus();
    }
  };
  // Said only while the read on screen is the one that followed it: a
  // start whose answer was lost shows as being written, and any later read
  // drops it.
  const failure =
    failed !== undefined && failed.after === read && !writing
      ? failed.reason
      : undefined;

  let controls: ReactNode = null;
  if (read !== undefined && read.state !== "ready") {
    controls = (
      <>
        <ErrorText>
          {read.state === "refused"
            ? read.message
            : t`Grasp can’t be reached just now.`}
        </ErrorText>
        <div>
          <Button
            disabled={busy}
            onClick={() => {
              setReads((before) => before + 1);
            }}
            variant="outline"
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      </>
    );
  } else if (read !== undefined && !writing) {
    const again = shown !== null && shown !== undefined;
    controls = (
      <>
        {shown?.state === "done" ? <Files shown={shown} /> : null}
        <div>
          <Button
            disabled={busy}
            onClick={() => {
              void start();
            }}
            variant="outline"
          >
            {again ? <Trans>Export again</Trans> : <Trans>Export</Trans>}
          </Button>
        </div>
      </>
    );
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
          and it is deleted when your data is erased.
        </Trans>
      </p>
      <output className="text-sm" ref={status} tabIndex={-1}>
        <Said read={read} shown={shown} />
      </output>
      {controls}
      <ErrorText>{failure}</ErrorText>
    </section>
  );
};
