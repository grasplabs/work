import type { LinkToSend } from "@grasp-os/shared/onboarding";
import { colors } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { formatList } from "../format.ts";

const styles = stylex.create({
  notice: { display: "block", color: colors.destructive },
});

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
  const failed = links.filter((link) => link.mailFailed);
  if (failed.length === 0) {
    return null;
  }
  const names = formatList(failed.map(({ name }) => name));
  return (
    <output {...stylex.props(styles.notice)}>
      <Trans>
        Our email didn’t reach {names}. Send them their link yourself from Links
        to send, or ask Grasp to check their address.
      </Trans>
    </output>
  );
};
