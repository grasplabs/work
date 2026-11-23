import {
  directoryProviderSchema,
  directorySuiteOf,
} from "@grasp-os/shared/directory";
import type { DirectoryProvider } from "@grasp-os/shared/directory";
import { Button } from "@grasp-os/ui/components/button";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import { useCore } from "../use-core.ts";

// Connecting the directory again after the onboarding (GRA-2171), under
// its read's status in Settings › Members: the flow the company step
// starts, coming back here, where nothing reads or saves a roster. Core
// and connect decide who may (the client's admins) and which account
// (one of the organization's own tenant): the same account renews the
// connection in place; another replaces it once it has shown it reads.
// The next daily read goes through it, a quarter of an hour away at most
// while reads fail, a day while they don't.

const styles = stylex.create({
  reconnect: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space[2],
  },
});

/** Where the sign-in of `provider`'s directory comes back to: this page, naming it. */
const membersPage = (provider: DirectoryProvider): string =>
  `/settings/members?directory=${provider}`;

/**
 * Back from the sign-in: the directory it was for, and the connection
 * connect made or mended.
 */
const returnedSchema = z.object({
  directory: directoryProviderSchema,
  connection: z.string().min(1),
});

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
  const returned = returnedSchema.safeParse(search);
  // Beside the button, never instead of it: the address keeps saying so
  // on a reload, when a later read may have failed again.
  const connectedAgain =
    returned.success && returned.data.directory === provider;
  const connect = async (): Promise<void> => {
    setState("starting");
    try {
      const { url } = await core.withSession(
        async (session) =>
          await session.onboarding.connectDirectory(
            directorySuiteOf(provider),
            membersPage(provider)
          )
      );
      window.location.assign(url);
    } catch {
      setState("failed");
    }
  };
  return (
    <div {...stylex.props(styles.reconnect)}>
      {connectedAgain ? (
        <Text size="sm">
          <Trans>
            {name} is connected again. Grasp reads it at its next daily read.
          </Trans>
        </Text>
      ) : null}
      <Button
        onClick={() => {
          void connect();
        }}
        size="sm"
        disabled={state === "starting"}
        variant="outline"
      >
        <Trans>Connect {name} again</Trans>
      </Button>
      {state === "failed" ? (
        <div role="alert">
          <Text size="sm">
            <Trans>
              {name} couldn’t be reached just now. Try again in a moment.
            </Trans>
          </Text>
        </div>
      ) : null}
    </div>
  );
};
