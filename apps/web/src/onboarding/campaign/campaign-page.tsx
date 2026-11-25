// The campaign page, what the client's admin sees while the interviews
// run, from fixtures in five states until core serves it:
// `/setup?step=listening&concept=c&state=…` shows it full screen in its
// own calm frame; Settings, Onboarding shows it in its section.
import { Button } from "@grasp-os/ui/components/button";
import { Container } from "@grasp-os/ui/components/container";
import { Icon, XIcon } from "@grasp-os/ui/lib/icons";
import { media, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useLocation } from "@tanstack/react-router";

import { GraspLogo } from "../../connections/brand-logos.ts";
import { CampaignWeek } from "./campaign-week.tsx";
import { Letter } from "./concepts/letter.tsx";
import { Mosaic } from "./concepts/mosaic.tsx";
import { RoadPage } from "./concepts/road.tsx";
import { campaigns } from "./fixtures.ts";
import type { CampaignState } from "./fixtures.ts";

/** The routes' `?concept=` letter: in development, which concept of the progress page shows. */
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
  main: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    paddingInline: { default: space[10], [media.maxSm]: space[4] },
    paddingBlockStart: { default: space[10], [media.maxSm]: space[6] },
    paddingBlockEnd: { default: space[16], [media.maxSm]: space[10] },
  },
});

/**
 * Concepts only, in development: `?concept=a|b|c` shows the progress
 * page as the letter, the company in one picture, or the road; without
 * it, the week as it is.
 */
const useProgressConcept = (): Concept | null => {
  const written = useLocation({ select: (location) => location.searchStr });
  const concept = new URLSearchParams(written).get("concept");
  return import.meta.env.DEV && isConcept(concept) ? concept : null;
};

/** The campaign page's content in one state, as the development switch picks it. */
export const CampaignConcept = ({ state }: { state: CampaignState }) => {
  const concept = useProgressConcept();
  const campaign = campaigns[state];
  if (concept === "a") {
    return <Letter campaign={campaign} />;
  }
  if (concept === "b") {
    return <Mosaic campaign={campaign} key={state} />;
  }
  if (concept === "c") {
    return <RoadPage campaign={campaign} />;
  }
  return <CampaignWeek campaign={campaign} />;
};

/**
 * The campaign page, full screen: Grasp's mark and a way out on one quiet
 * bar, the week in a column under it. The page scrolls.
 */
export const CampaignFrame = ({ state }: { state: CampaignState }) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.window)}>
      <header {...stylex.props(styles.bar)}>
        <span {...stylex.props(styles.mark)}>
          <Icon icon={GraspLogo} label="Grasp" />
        </span>
        <Button
          aria-label={t`Close`}
          asChild
          size="icon-sm"
          tooltip={t`Close`}
          variant="ghost"
        >
          <Link to="/">
            <Icon icon={XIcon} />
          </Link>
        </Button>
      </header>
      <main {...stylex.props(styles.main)}>
        <Container size="lg" style={styles.column}>
          <CampaignConcept state={state} />
        </Container>
      </main>
    </div>
  );
};
