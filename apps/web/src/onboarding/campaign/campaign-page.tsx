// The campaign page, what the client's admin sees while the interviews
// run, as core tells the campaign (`onboarding.campaign`): the setup's
// last screen (`/setup?step=listening`), full screen in its own calm
// frame. An old link to Settings, Onboarding leads here too.
import type { Campaign } from "@grasp-os/shared/onboarding-campaign";
import { Button } from "@grasp-os/ui/components/button";
import { Container } from "@grasp-os/ui/components/container";
import { Icon, XIcon } from "@grasp-os/ui/lib/icons";
import { media, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter } from "@tanstack/react-router";

import { GraspLogo } from "../../connections/brand-logos.ts";
import { TopErrorBar } from "../../frame/top-error.tsx";
import { StartOver } from "../start-over.tsx";
import { CampaignWeek } from "./campaign-week.tsx";

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
  tools: { display: "flex", alignItems: "center", gap: space[1] },
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
 * The campaign page, full screen: Grasp's mark, and on a local stack the
 * start-over button beside the way out, on one quiet bar, the week in a column under it. The page scrolls.
 */
export const CampaignFrame = ({ campaign }: { campaign: Campaign }) => {
  const { t } = useLingui();
  const router = useRouter();
  return (
    <div {...stylex.props(styles.window)}>
      {/* Every error is said here, at the very top, above the bar. */}
      <TopErrorBar />
      <header {...stylex.props(styles.bar)}>
        <span {...stylex.props(styles.mark)}>
          <Icon icon={GraspLogo} label="Grasp" />
        </span>
        <div {...stylex.props(styles.tools)}>
          <StartOver size="icon-sm" />
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
        </div>
      </header>
      <main {...stylex.props(styles.main)}>
        <Container size="lg" style={styles.column}>
          <CampaignWeek
            campaign={campaign}
            // What core tells is read again: the ask done is gone, or says so.
            onChanged={async () => {
              await router.invalidate({ sync: true });
            }}
          />
        </Container>
      </main>
    </div>
  );
};
