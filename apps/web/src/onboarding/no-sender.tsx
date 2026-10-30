import { useLingui } from "@lingui/react/macro";

// Where Grasp can send mail but no sender is set (core's `MAIL_FROM`):
// there is no domain to let through yet, and each mail fails until it is
// set, so the step says so instead of a domain it would have to guess.

/** That Grasp has no sender for its mail yet, and what that means for the links. */
export const NoSenderItem = () => {
  const { t } = useLingui();
  return (
    <div className="flex flex-col border-t py-4 text-left last:border-b">
      <span className="font-medium">{t`Grasp has no sender for its mail yet`}</span>
      <span className="text-muted-foreground">{t`Until Grasp support sets one, interview links can’t go out by email. Send each one their link by hand from Interviews.`}</span>
    </div>
  );
};
