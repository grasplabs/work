import type {
  DirectoryDeletedFailure,
  DirectoryProvider,
} from "@grasp-os/shared/directory";
import type { DirectoryRead } from "@grasp-os/shared/members";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { CircleAlertIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { formatDateTime } from "../format.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { adviceOf } from "./directory-read-advice.ts";
import type { ReadAdvice } from "./directory-read-advice.ts";
import { DirectoryReconnect } from "./directory-reconnect.tsx";
import { SettingsBody, SettingsSection } from "./settings-parts.tsx";

// Where the directory's daily read stands (GRA-2056, slice 4; GRA-2144),
// for admins in Settings › Members: when it was last applied, and what an
// admin can do when the reads since failed, or went without the accounts
// deleted in the directory. It reads its own data, so it is mounted with
// one line. Nothing shows before a read was tried (with no directory, the
// admin's own list is the source), nor when it can't be read.
//
// A failure an admin mends by connecting the directory again offers that
// beside it (directory-reconnect.tsx, GRA-2171).

/** The directory's provider, by its product's name (not translated). */
const providerNames: Record<DirectoryProvider, string> = {
  "microsoft-directory": "Microsoft Entra",
  "google-directory": "Google Workspace",
};

/** What an admin can do about the reads failing, in one sentence. */
const FailureAdvice = ({ advice }: { advice: ReadAdvice }) => {
  const said: Record<ReadAdvice, ReactElement> = {
    connect: (
      <Trans>
        Grasp can’t read the directory with the connection it has. Connect it
        again, signing in with an account that administers your directory.
      </Trans>
    ),
    tooLarge: (
      <Trans>
        The directory holds more people than Grasp can read at once. Ask Grasp’s
        support to help.
      </Trans>
    ),
    wait: (
      <Trans>
        Grasp tries again every quarter of an hour. If it keeps failing, ask
        Grasp’s support to help.
      </Trans>
    ),
  };
  return said[advice];
};

/** Why the last read went without the deleted accounts, true for each reason. */
const DeletedReason = ({ reason }: { reason: DirectoryDeletedFailure }) => {
  const said: Record<DirectoryDeletedFailure, ReactElement> = {
    "directory.deleted_refused": (
      <Trans>
        The directory refused to list them, so nobody was suspended for an
        account deleted there; everything else was read. The account that
        connected the directory may lack the right to list them: ask Grasp’s
        support.
      </Trans>
    ),
    "directory.deleted_unsupported": (
      <Trans>
        The directory’s list of them didn’t answer as a list, so nobody was
        suspended for an account deleted there; everything else was read. Grasp
        tries again at its next daily read. If this stays, ask Grasp’s support.
      </Trans>
    ),
  };
  return said[reason];
};

/** One directory's read: when it was last applied, and what needs an admin. */
const ReadStatus = ({ read }: { read: DirectoryRead }) => {
  const name = providerNames[read.provider];
  const readAt = read.readAt === null ? null : formatDateTime(read.readAt);
  const people = read.people ?? 0;
  const { failure, deletedFailure } = read;
  const failedAt = failure === null ? null : formatDateTime(failure.at);
  return (
    <div className="flex flex-col gap-3">
      <p>
        {readAt === null ? (
          <Trans>{name} hasn’t been read yet.</Trans>
        ) : (
          <Plural
            one={`${name} was last read ${readAt}, listing # person.`}
            other={`${name} was last read ${readAt}, listing # people.`}
            value={people}
          />
        )}
      </p>
      {failure === null ? null : (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>
            <Trans>
              The directory couldn’t be read, last tried {failedAt}.
            </Trans>
          </AlertTitle>
          <AlertDescription>
            <p>
              <FailureAdvice advice={adviceOf(failure.code)} />
            </p>
            {adviceOf(failure.code) === "connect" ? (
              <DirectoryReconnect name={name} provider={read.provider} />
            ) : null}
            <p>
              <Trans>
                Until a read succeeds, nobody joins, moves or is suspended
                through the directory.
              </Trans>
            </p>
          </AlertDescription>
        </Alert>
      )}
      {/* About the last read applied: while the reads since fail, that failure is what to mend. */}
      {deletedFailure === null || failure !== null ? null : (
        <Alert variant="attention">
          <TriangleAlertIcon />
          <AlertTitle>
            <Trans>
              The last read couldn’t list the accounts deleted in the directory.
            </Trans>
          </AlertTitle>
          <AlertDescription>
            <DeletedReason reason={deletedFailure} />
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
};

/** The directory's reads, once one was tried; nothing before, or unread. */
export const DirectoryReads = () => {
  const { t } = useLingui();
  const core = useCore();
  const [reads, setReads] = useState<DirectoryRead[]>([]);
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const loaded = await loadFromCore(
        core,
        async (session) => await session.members.directoryReads(),
        left.signal
      );
      if (!left.signal.aborted && loaded.state === "ready") {
        setReads(loaded.data);
      }
    };
    void read();
    return () => {
      left.abort();
    };
  }, [core]);
  if (reads.length === 0) {
    return null;
  }
  return (
    <SettingsSection
      description={t`Grasp reads your directory once a day, and keeps members, their teams and their suspensions as it says.`}
      title={t`Directory`}
    >
      <SettingsBody>
        {reads.map((read) => (
          <ReadStatus key={read.provider} read={read} />
        ))}
      </SettingsBody>
    </SettingsSection>
  );
};
