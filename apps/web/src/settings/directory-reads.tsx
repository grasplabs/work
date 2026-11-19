import type { DirectoryProvider } from "@grasp-os/shared/directory";
import type {
  DirectoryErrorCode,
  DirectoryRead,
} from "@grasp-os/shared/members";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { CircleAlertIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactElement } from "react";

import { formatDateTime } from "../format.ts";
import { SettingsBody, SettingsSection } from "./settings-parts.tsx";

// Where the directory's daily read stands (GRA-2056, slice 4; GRA-2144),
// for admins in Settings › Members: when it was last applied, and what an
// admin can do when the reads since failed, or went without the accounts
// deleted in the directory. Nothing shows before a read was tried: with
// no directory, the admin's own list is the source.

/** The directory's provider, by its product's name (not translated). */
const providerNames: Record<DirectoryProvider, string> = {
  "microsoft-directory": "Microsoft Entra",
  "google-directory": "Google Workspace",
};

/** The way back to connecting the directory: the onboarding's company step. */
const ConnectAgain = () => (
  <AlertAction placement="below">
    <Button
      nativeButton={false}
      render={<Link search={{ step: "company" }} to="/setup" />}
      size="sm"
      variant="outline"
    >
      <Trans>Connect the directory again</Trans>
    </Button>
  </AlertAction>
);

/** What an admin can do about the reads failing. */
type Advice = "connect" | "otherTenant" | "tooLarge" | "wait";

/**
 * What an admin can do about reads failing with `code`: connect the
 * directory again for a connection Grasp can't read with, and otherwise
 * wait for the next try, which mends what passes (throttling, a provider
 * that didn't answer), or ask for help.
 */
const adviceOf = (code: DirectoryErrorCode): Advice => {
  if (
    code === "directory.inactive" ||
    code === "directory.not_found" ||
    code === "directory.not_connected"
  ) {
    return "connect";
  }
  if (code === "directory.other_tenant") {
    return "otherTenant";
  }
  return code === "directory.too_large" ? "tooLarge" : "wait";
};

/** What an admin can do about the reads failing, in one sentence. */
const FailureAdvice = ({ advice }: { advice: Advice }) => {
  const said: Record<Advice, ReactElement> = {
    connect: (
      <Trans>
        Grasp can no longer read the directory with its connection. Connect it
        again with an administrator’s account.
      </Trans>
    ),
    otherTenant: (
      <Trans>
        The connected directory belongs to another organization than the one
        people sign in with. Connect your own organization’s directory.
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

/** That the reads since the last one applied failed, why, and what to do. */
const ReadFailed = ({
  failure,
  readAt,
}: {
  failure: NonNullable<DirectoryRead["failure"]>;
  readAt: string | null;
}) => {
  const failedAt = formatDateTime(failure.at);
  const advice = adviceOf(failure.code);
  const lastRead = readAt === null ? null : formatDateTime(readAt);
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>
        <Trans>The directory couldn’t be read, last tried {failedAt}.</Trans>
      </AlertTitle>
      <AlertDescription>
        <p>
          <FailureAdvice advice={advice} />
        </p>
        <p>
          {lastRead === null ? (
            <Trans>
              Until a read succeeds, nobody joins, moves or is suspended through
              the directory.
            </Trans>
          ) : (
            <Trans>
              Nothing has changed through the directory since the read of{" "}
              {lastRead}: until a read succeeds, nobody joins, moves or is
              suspended through it.
            </Trans>
          )}
        </p>
      </AlertDescription>
      {advice === "connect" || advice === "otherTenant" ? (
        <ConnectAgain />
      ) : null}
    </Alert>
  );
};

/** That the last read went without the accounts deleted in the directory. */
const WithoutDeleted = () => (
  <Alert variant="attention">
    <TriangleAlertIcon />
    <AlertTitle>
      <Trans>
        The last read couldn’t list the accounts deleted in the directory.
      </Trans>
    </AlertTitle>
    <AlertDescription>
      <Trans>
        Everything else was read, but nobody was suspended for an account
        deleted there. Connect the directory again with an administrator’s
        account. If this stays, ask Grasp’s support to help.
      </Trans>
    </AlertDescription>
    <ConnectAgain />
  </Alert>
);

/** One directory's read: when it was last applied, and what needs an admin. */
const ReadStatus = ({ read }: { read: DirectoryRead }) => {
  const name = providerNames[read.provider];
  const readAt = read.readAt === null ? null : formatDateTime(read.readAt);
  const people = read.people ?? 0;
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
      {read.failure === null ? null : (
        <ReadFailed failure={read.failure} readAt={read.readAt} />
      )}
      {/* About the last read applied: while the reads since fail, that failure is what to mend. */}
      {read.deletedFailure === null || read.failure !== null ? null : (
        <WithoutDeleted />
      )}
    </div>
  );
};

/** The directory's reads, once one was tried; nothing before. */
export const DirectoryReads = ({ reads }: { reads: DirectoryRead[] }) => {
  const { t } = useLingui();
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
