import { Trans } from "@lingui/react/macro";
import { UsersIcon } from "lucide-react";

import { isCompanyOpinion } from "./brain.ts";

// What the brain shows of the interviews (GRA-1084): a statement the
// onboarding gave it is a claim five or more of a team's people made, put
// together (core's onboarding/team-claims.ts), never one person's words,
// and the page says so: never quoted (brain.ts `statementWords`), and with what it
// rests on where it stands on its own.

/**
 * Under a team's claim or a company's opinion (`statementId`): who it
 * rests on, never who said it nor how many, and an opinion never a team.
 */
export const ClaimBasis = ({ statementId }: { statementId: string }) => (
  <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
    <UsersIcon aria-hidden className="size-3" />
    {isCompanyOpinion(statementId) ? (
      <Trans comment="Under a statement put together from what people across the company told, only counted anonymously">
        Said by five or more people across the company
      </Trans>
    ) : (
      <Trans comment="Under a statement put together from the interviews">
        Said by five or more people
      </Trans>
    )}
  </span>
);
