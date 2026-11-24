// Concepts only (never merged): the campaign page, what the client's
// admin sees while the interviews run, in three concepts, each in five
// states from fixtures. `/setup?step=listening&concept=a|b|c&state=…`
// shows it full screen in its own calm frame; Settings, Onboarding shows
// the same component in its section (`?concept=…&state=…`).
import { Button } from "@grasp-os/ui/components/button";
import { Container } from "@grasp-os/ui/components/container";
import { Icon, XIcon } from "@grasp-os/ui/lib/icons";
import { media, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";

import { GraspLogo } from "../../connections/brand-logos.ts";
import { CampaignDots } from "./concept-dots.tsx";
import { CampaignMeadow } from "./concept-meadow.tsx";
import { CampaignNotes } from "./concept-notes.tsx";
import { campaigns } from "./fixtures.ts";
import type { CampaignState } from "./fixtures.ts";

export type Concept = "a" | "b" | "c";

export const isConcept = (value: unknown): value is Concept =>
  value === "a" || value === "b" || value === "c";

const styles = stylex.create({
  window: {
    display: "flex",
    flexDirection: "column",
    minHeight: "100svh",
  },
  bar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexShrink: 0,
    height: "4.5rem",
    paddingInline: { default: space[10], [media.maxSm]: space[4] },
  },
  column: { width: "100%" },
  mark: { display: "flex", [iconVars.size]: size.iconDefault },
  // On a phone what little there is stands in the window's middle, as the onboarding's steps did.
  main: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    justifyContent: { default: "flex-start", [media.maxSm]: "center" },
    paddingInline: { default: space[10], [media.maxSm]: space[4] },
    paddingBlockStart: { default: space[8], [media.maxSm]: space[2] },
    paddingBlockEnd: { default: space[16], [media.maxSm]: space[20] },
  },
});

/** Which width each concept reads at: the meadow and the week wide, the notes a reading column. */
const widths = { a: "lg", b: "lg", c: "lg" } as const;

/** One concept in one state. */
export const CampaignConcept = ({
  concept,
  state,
}: {
  concept: Concept;
  state: CampaignState;
}) => {
  const campaign = campaigns[state];
  if (concept === "a") {
    return <CampaignMeadow campaign={campaign} />;
  }
  if (concept === "b") {
    return <CampaignNotes campaign={campaign} />;
  }
  return <CampaignDots campaign={campaign} />;
};

/**
 * The onboarding's campaign page, full screen: Grasp's mark and a way out
 * on one quiet bar, the concept in a column under it. The page scrolls.
 */
export const CampaignFrame = ({
  concept,
  state,
}: {
  concept: Concept;
  state: CampaignState;
}) => (
  <div {...stylex.props(styles.window)}>
    <header {...stylex.props(styles.bar)}>
      <span {...stylex.props(styles.mark)}>
        <Icon icon={GraspLogo} label="Grasp" />
      </span>
      <Button
        aria-label="Close"
        asChild
        size="icon-sm"
        tooltip="Close"
        variant="ghost"
      >
        <Link to="/">
          <Icon icon={XIcon} />
        </Link>
      </Button>
    </header>
    <main {...stylex.props(styles.main)}>
      <Container size={widths[concept]} style={styles.column}>
        <CampaignConcept concept={concept} state={state} />
      </Container>
    </main>
  </div>
);
