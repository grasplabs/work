import { onboardingIdPrefix } from "@grasp-os/shared/brain-records";
import { Trans } from "@lingui/react/macro";
import { UsersIcon } from "lucide-react";

// What the brain shows of the interviews (GRA-1084): a statement the
// onboarding gave it is a claim five or more of a team's people made, put
// together (core's onboarding/team-claims.ts), never one person's words,
// and the page says so.

/** Whether a statement is one of the onboarding's claims: what five or more people said, put together. */
export const isTeamClaim = (statementId: string): boolean =>
  statementId.startsWith(onboardingIdPrefix);

/** Under a team's claim: who it rests on, never who said it. */
export const ClaimBasis = () => (
  <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
    <UsersIcon aria-hidden className="size-3" />
    <Trans comment="Under a statement put together from the interviews">
      Said by five or more people
    </Trans>
  </span>
);
