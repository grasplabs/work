import type { LinkToSend } from "@grasp-os/shared/onboarding";
import { useLingui } from "@lingui/react/macro";

import { formatList } from "../format.ts";
import { TopError } from "../frame/top-error.tsx";

// Whose link from Grasp failed, for the company's admin among the
// interviews: the email with it didn't reach them, so they won't start
// unless the admin sends them their link another way, or puts their
// address right for Grasp's staff to send it again. Only names: never an
// address, and never a reminder (`LinkToSend.mailFailed`).

export const FailedMailNotice = ({
  links,
}: {
  links: readonly LinkToSend[];
}) => {
  const { t } = useLingui();
  const failed = links.filter((link) => link.mailFailed);
  const names = formatList(failed.map(({ name }) => name));
  // Said in the bar at the top, as every error in the setup is.
  return (
    <TopError>
      {failed.length === 0
        ? null
        : t`Our email didn’t reach ${names}. Send them their link yourself from Links to send, or ask Grasp to check their address.`}
    </TopError>
  );
};
