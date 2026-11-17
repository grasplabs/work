import { Trans } from "@lingui/react/macro";
import { UsersIcon } from "lucide-react";

// What the brain shows of the interviews (GRA-1084, GRA-1987): a statement
// the onboarding gave it is a claim of how a team works, made from what its
// people shared with their team (core's onboarding/team-claims.ts), never
// one person's words, and the page says so: never quoted (brain.ts
// `statementWords`), and with what it rests on where it stands on its own.
// Never how many told it: it shows from the first person who did.

/** Under a team's claim: what it rests on, never who said it, nor how many. */
export const ClaimBasis = () => (
  <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
    <UsersIcon aria-hidden className="size-3" />
    <Trans comment="Under a statement put together from the interviews">
      How the team works, as its people told it
    </Trans>
  </span>
);
