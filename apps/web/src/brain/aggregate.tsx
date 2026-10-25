import { onboardingIdPrefix } from "@grasp-os/shared/brain-records";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Trans } from "@lingui/react/macro";
import { UsersIcon } from "lucide-react";

// What the brain shows of the interviews (GRA-1084): a statement the
// onboarding gave it is a claim five or more of a team's people made, put
// together (core's onboarding/team-claims.ts), never one person's words,
// and the page says so. Grasp's staff read numbers only: core gives them
// no statement and no drawing's words, and the page tells them why the
// brain looks bare.

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

/** At the top of the brain for Grasp's staff: they read its numbers only. */
export const StaffNumbersOnly = ({ staff }: { staff: boolean }) =>
  staff ? (
    <Alert className="m-4 w-auto" live="polite">
      <UsersIcon />
      <AlertTitle>
        <Trans>You see the brain’s numbers only</Trans>
      </AlertTitle>
      <AlertDescription>
        <Trans>
          As Grasp staff, you see how many people took part and the numbers they
          gave, never what the company’s people said.
        </Trans>
      </AlertDescription>
    </Alert>
  ) : null;
