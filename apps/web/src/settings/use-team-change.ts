import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { TeamChangeError } from "./team-changes.ts";

/**
 * Runs a change to a team, then reads the teams again with `refresh`,
 * whatever came of it: `busy` while it runs, and `failure` saying why it
 * didn't go through, which `run` also hands back (nothing once it did).
 */
export const useTeamChange = (refresh: () => Promise<void>) => {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const run = async (
    change: () => Promise<void>,
    failed: string
  ): Promise<string | undefined> => {
    setBusy(true);
    setFailure(undefined);
    let refused: string | undefined;
    try {
      await changeThenRefresh(change, refresh);
    } catch (error) {
      refused =
        error instanceof TeamChangeError && error.status === 403
          ? t`Only admins can change teams.`
          : failed;
    }
    setFailure(refused);
    setBusy(false);
    return refused;
  };
  return { busy, failure, run };
};
