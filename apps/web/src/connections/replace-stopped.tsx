import type { ListedConnection } from "@grasp-os/shared/connect";
import { failureText } from "@grasp-os/shared/errors";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useCore } from "../use-core.ts";
import type { Integration } from "./integrations.ts";

// Connecting a Composio toolkit again, once its shared connections stopped
// working, replaces them, but only after the new one is made. Core has no
// replace of its own, and a sign-in happens at the provider, so the page
// notes the stopped ones in this tab as the browser leaves, and
// disconnects them when the flow comes back here with the new connection.
// A sign-in refused, cancelled or never finished leaves them as they were,
// with their consent record, who may read in the Brain what agents read
// through them, and the permissions held for them. Only this tab's own
// note counts, never the address: a link can't ask for a disconnect.

/** Where this tab notes the connections a toolkit's new one replaces. */
const noteKey = (integration: string): string =>
  `grasp.replacing.${integration}`;

/** Notes, as the browser leaves to connect `integration` again, the stopped connections the new one replaces. */
export const noteReplacing = (
  integration: string,
  replacing: readonly ListedConnection[]
): void => {
  try {
    sessionStorage.setItem(
      noteKey(integration),
      replacing.map(({ id }) => id).join(" ")
    );
  } catch {
    // Storage refused: the stopped ones stay, and each row still disconnects its own.
  }
};

/** The connections noted for `integration`, forgotten as they are read. */
const takeReplacing = (integration: string): ReadonlySet<string> => {
  try {
    const noted = sessionStorage.getItem(noteKey(integration));
    sessionStorage.removeItem(noteKey(integration));
    return new Set(noted === null ? [] : noted.split(" "));
  } catch {
    return new Set();
  }
};

/**
 * Disconnects the stopped connections this tab noted for `integration`,
 * once the flow came back with `made`, a working shared Composio
 * connection of it; then reads the page again. Only those still listed as
 * stopped and shared. Why they couldn't all be disconnected; nothing
 * otherwise.
 */
const useReplaceStopped = (
  integration: Integration,
  made: ListedConnection | undefined
): string | undefined => {
  const core = useCore();
  const router = useRouter();
  const [failure, setFailure] = useState<string>();
  const { key, connections } = integration;
  const madeId =
    made?.source === "composio" &&
    made.scope === "shared" &&
    made.status === "active"
      ? made.id
      : undefined;
  useEffect(() => {
    if (madeId === undefined) {
      return;
    }
    const noted = takeReplacing(key);
    const stopped = connections.filter(
      ({ id, source, scope, status }) =>
        noted.has(id) &&
        id !== madeId &&
        source === "composio" &&
        scope === "shared" &&
        status === "needs_reauth"
    );
    if (stopped.length === 0) {
      return;
    }
    const replace = async (): Promise<void> => {
      try {
        await core.withSession(async (session) => {
          const done = await Promise.allSettled(
            stopped.map(
              async ({ id }) => await session.connections.disconnect(id)
            )
          );
          const refused = done.find(({ status }) => status === "rejected");
          if (refused?.status === "rejected") {
            throw refused.reason;
          }
        });
      } catch (error) {
        setFailure(failureText(error));
      }
      await router.invalidate({ sync: true });
    };
    void replace();
  }, [core, router, key, connections, madeId]);
  return failure;
};

/**
 * Replaces a toolkit's stopped connections once the flow came back with
 * `made` (`useReplaceStopped`), and says so on the page where one of them
 * couldn't be disconnected: it is still there, on its own row, to
 * disconnect from there.
 */
export const ReplaceStopped = ({
  integration,
  made,
}: {
  integration: Integration;
  made: ListedConnection | undefined;
}) => {
  const { t } = useLingui();
  const failure = useReplaceStopped(integration, made);
  const app = integration.name;
  return failure === undefined ? null : (
    <Alert variant="destructive">
      <AlertTitle>
        {t`${app} is connected again, but the connection that stopped couldn't be disconnected. Disconnect it from its row.`}
      </AlertTitle>
      <AlertDescription>{failure}</AlertDescription>
    </Alert>
  );
};
