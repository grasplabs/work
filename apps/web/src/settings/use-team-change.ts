import { staffListTeamRefusals } from "@grasp-os/shared/onboarding";
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
  /** What a refusal core explains says, if it is one. */
  const refusalOf = (error: unknown): string | undefined => {
    if (!(error instanceof TeamChangeError)) {
      return undefined;
    }
    if (error.status === 403) {
      return t`Only admins can change teams.`;
    }
    // The onboarding's staff list's own refusals (core's auth.ts,
    // GRA-2055), each by its code: a team on the list, saved or as last
    // confirmed, is deleted only once it is off both; and a name the list
    // gives a team it hasn't made yet is the list's.
    if (error.code === staffListTeamRefusals.onList) {
      return t`This team is on the staff list. Take it off there and confirm the list first.`;
    }
    if (error.code === staffListTeamRefusals.notMadeYet) {
      return t`A team on the staff list has this name. It appears here once the staff list is confirmed.`;
    }
    return undefined;
  };
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
      refused = refusalOf(error) ?? failed;
    }
    setFailure(refused);
    setBusy(false);
    return refused;
  };
  return { busy, failure, run };
};
