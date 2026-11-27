import { connectionErrors } from "@grasp-os/shared/connect";
import { useLingui } from "@lingui/react/macro";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";

// A sign-in a setup step started that didn't finish comes back to that
// step with `connectionError=<code>` (core's connection callback): the step
// says so in its own words, with what to do, and the code leaves the
// address so a reload or a later visit doesn't say it again. Anyone can
// put anything in a link, so only a known code picks the words, and the
// value itself is never shown.

const failedSchema = z.object({ connectionError: z.string().min(1).max(64) });

/** What a setup step says of a sign-in that came back without connecting, once; null when it didn't come back so. */
export const useConnectionReturn = (): string | null => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const search: unknown = useSearch({ strict: false });
  const failed = failedSchema.safeParse(search);
  const code = failed.success ? failed.data.connectionError : null;
  // The words for the codes a step's sign-in comes back with most; the rest, one way.
  const words: Partial<Record<string, string>> = {
    "connection.provider_refused": t`The sign-in didn't finish, so nothing was connected. Try again, or choose another way.`,
    "connection.wrong_account": t`That account isn't in your organization. Try again with your work account.`,
    "connection.flow_invalid": t`The sign-in took too long, so nothing was connected. Try again.`,
    "connection.directory_unreadable": t`That account can't read your company's directory. Try again with an admin account, or use a staff list.`,
    "connection.directory_unchecked": t`I couldn't check your directory just now. Try again in a moment.`,
    "connection.provider_unavailable": t`That sign-in can't be reached right now. Try again in a moment, or choose another way.`,
  };
  const sayOf = (given: string): string => {
    const known = connectionErrors.codeOf({ code: given });
    return (
      (known === undefined ? undefined : words[known]) ??
      t`Connecting didn't work, so nothing was connected. Try again, or choose another way.`
    );
  };
  // Kept once read: the code leaves the address straight after.
  const [kept, setKept] = useState(code);
  if (code !== null && code !== kept) {
    setKept(code);
  }
  useEffect(() => {
    if (code !== null) {
      void navigate({
        to: ".",
        search: (previous: Record<string, unknown>) => {
          const { connectionError: _gone, ...rest } = previous;
          return rest;
        },
        replace: true,
      });
    }
  }, [code, navigate]);
  return kept === null ? null : sayOf(kept);
};
