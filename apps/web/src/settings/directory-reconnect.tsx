import { directorySuiteOf } from "@grasp-os/shared/directory";
import type { DirectoryProvider } from "@grasp-os/shared/directory";
import { Button } from "@grasp-os/ui/components/button";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Trans } from "@lingui/react/macro";
import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import { useCore } from "../use-core.ts";

// Connecting the directory again after the onboarding (GRA-2171), beside
// the read's failure in Settings › Members: the flow the company step
// starts, coming back here, where nothing reads or saves a roster. Core
// and connect decide who may (the client's admins) and which account
// (one of the organization's own tenant); a connection made with another
// account replaces the one before it. The next quarter hour's read then
// goes through it.

/** Where the sign-in comes back to: this page. */
const membersPage = "/settings/members";

/** Back from the sign-in: connect names the connection it made or mended. */
const returnedSchema = z.object({ connection: z.string().min(1) });

/** A button that connects `provider`'s directory again; once back, says what follows. */
export const DirectoryReconnect = ({
  name,
  provider,
}: {
  /** The directory's product name, not translated. */
  name: string;
  provider: DirectoryProvider;
}) => {
  const core = useCore();
  const search: unknown = useSearch({ strict: false });
  const [state, setState] = useState<"idle" | "starting" | "failed">("idle");
  if (returnedSchema.safeParse(search).success) {
    return (
      <p>
        <Trans>
          {name} is connected again. Grasp reads it within a quarter of an hour.
        </Trans>
      </p>
    );
  }
  const connect = async (): Promise<void> => {
    setState("starting");
    try {
      const { url } = await core.withSession(
        async (session) =>
          await session.onboarding.connectDirectory(
            directorySuiteOf(provider),
            membersPage
          )
      );
      window.location.assign(url);
    } catch {
      setState("failed");
    }
  };
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        disabled={state === "starting"}
        onClick={() => {
          void connect();
        }}
        size="sm"
        variant="outline"
      >
        {state === "starting" ? <Spinner data-icon="inline-start" /> : null}
        <Trans>Connect {name} again</Trans>
      </Button>
      {state === "failed" ? (
        <p role="alert">
          <Trans>
            {name} couldn’t be reached just now. Try again in a moment.
          </Trans>
        </p>
      ) : null}
    </div>
  );
};
