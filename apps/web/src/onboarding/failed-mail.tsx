import type { LinkToSend } from "@grasp-os/shared/onboarding";
import { Trans } from "@lingui/react/macro";

import { formatList } from "../format.ts";

// Whose mail from Grasp failed, for the company's admin among the
// interviews: their link or reminder didn't reach them, so they won't
// start unless the admin sends them their link another way. Grasp's staff
// see why, and send it again once it is put right. Only names: never an
// address or the reason, which are for Grasp to sort out.

export const FailedMailNotice = ({
  links,
}: {
  links: readonly LinkToSend[];
}) => {
  const failed = links.filter((link) => link.failedMail !== null);
  if (failed.length === 0) {
    return null;
  }
  const names = formatList(failed.map(({ name }) => name));
  return (
    <output className="text-destructive block">
      <Trans>
        Our email didn’t reach {names}. Send them their link yourself from Links
        to send, or ask Grasp to check their address.
      </Trans>
    </output>
  );
};
