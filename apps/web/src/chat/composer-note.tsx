import { Trans } from "@lingui/react/macro";

// The line under an open chat's composer, as the prototype has it
// (grasplabs/prototype `routes/index.tsx`): where answers come from, by
// the organization's name. A new chat has no line under its box.

/** Under an open chat's composer: answers come from what the organization shared. */
export const ComposerNote = ({
  organizationName,
}: {
  /** None when the organization has no name, or core couldn't say it. */
  organizationName: string | undefined;
}) => (
  <p className="text-muted-foreground text-center text-xs">
    {organizationName === undefined ? (
      <Trans>
        Answers come only from what your organization shared, with sources.
      </Trans>
    ) : (
      <Trans>
        Answers come only from what {organizationName} shared, with sources.
      </Trans>
    )}
  </p>
);
