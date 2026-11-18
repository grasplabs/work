import { Trans } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { Icon, People } from "../grasp/icons/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// What the brain shows of the interviews (GRA-1084): a statement the
// onboarding gave it is a claim five or more of a team's people made, put
// together (core's onboarding/team-claims.ts), never one person's words,
// and the page says so: never quoted (brain.ts `statementWords`), and with what it
// rests on where it stands on its own.

const styles = stylex.create({
  basis: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
});

/** Under a team's claim: who it rests on, never who said it. */
export const ClaimBasis = () => (
  <span {...stylex.props(styles.basis)}>
    <Icon icon={People} />
    <Trans comment="Under a statement put together from the interviews">
      Said by five or more people
    </Trans>
  </span>
);
