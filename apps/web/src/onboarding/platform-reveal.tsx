import { useLingui } from "@lingui/react/macro";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { brainDots } from "../brain/dot-ink.ts";
import { DotsBuild } from "../brain/dots-build.tsx";
import { useLessMotion } from "../brain/less-motion.ts";
import { hold } from "../voice/voice.ts";
import { currentReveal, setReveal, useReveal } from "./reveal-state.ts";
import { readingSeconds } from "./setup.ts";

// The way into the platform at the end of the onboarding, told as one
// piece across two pages, as in the prototype (grasplabs/prototype,
// packages/grasp: components/onboarding/reveal.ts, platform-reveal.tsx).
// Filling: Stephen says he will put it all together while the brain fills
// up and charges. Clearing: everything but the brain fades. Building: its
// dots are handed to the layer above every page, which flies them out to
// build the platform's first page while it opens underneath, then
// dissolves into it. The pages only look at which phase it is.

/** However quick his line, the brain takes this long to fill; and this long for the rest to fade. */
const fillMs = 1800;
const clearMs = 550;
/** His line never holds the way in longer than this. */
const lineMs = 6000;
/** How often the last step asks core again whether Grasp gave its go. */
const goCheckMs = 15_000;
/** A breath after the last step is explained before the way in begins. */
const wayInAfterMs = 700;

/**
 * Plays the way in: the brain fills while Stephen says `line` (the step
 * says it), and `enter` goes into the platform once the brain's dots are
 * handed over. Once at a time. A pause holds it where it is.
 */
const revealPlatform = async (
  line: string,
  enter: () => void
): Promise<void> => {
  if (currentReveal().phase !== "idle") {
    return;
  }
  setReveal({ phase: "filling", from: null });
  await hold(Math.max(fillMs, Math.min(readingSeconds(line) * 1000, lineMs)));
  setReveal({ phase: "clearing", from: null });
  await hold(clearMs);
  // Taken before the page changes, while the brain is still on screen.
  setReveal({ phase: "building", from: brainDots() });
  enter();
};

/**
 * The way in from the last step of the onboarding: while Grasp has not
 * given its go (`open`), core is asked again now and then, so it begins
 * the moment it does; once it has and the step has been `explained`, a
 * breath, then the brain fills while Stephen says `line`, and its dots
 * build the platform's first page, the dashboard.
 */
export const useWayIn = ({
  open,
  explained,
  line,
}: {
  open: boolean;
  explained: boolean;
  line: string;
}): void => {
  const router = useRouter();
  const navigate = useNavigate();
  useEffect(() => {
    const id = open
      ? undefined
      : window.setInterval(() => {
          void router.invalidate();
        }, goCheckMs);
    return () => {
      window.clearInterval(id);
    };
  }, [open, router]);
  useEffect(() => {
    const id =
      open && explained
        ? window.setTimeout(() => {
            void revealPlatform(line, () => {
              void navigate({ to: "/dashboard" });
            });
          }, wayInAfterMs)
        : undefined;
    return () => {
      window.clearTimeout(id);
    };
  }, [open, explained, line, navigate]);
};

/** The platform has dissolved into view. */
const endReveal = (): void => {
  setReveal({ phase: "idle", from: null });
};

/** The platform shows underneath once its frame has something in it. */
const platformShows = (): boolean => {
  const inset = document.querySelector('[data-slot="sidebar-inset"]');
  return inset !== null && inset.childElementCount > 0;
};

const pageOf = (): Element => document.body;

/**
 * The layer above every page that carries the brain into the platform. It
 * takes the brain's dots over exactly where they are, on the page's own
 * background, so the onboarding can go and the platform open underneath
 * unseen; then the dots build the platform and dissolve into it. With
 * less motion, it simply fades.
 */
export const PlatformReveal = () => {
  const { t } = useLingui();
  const { phase, from } = useReveal();
  const still = useLessMotion();
  if (phase !== "building") {
    return null;
  }
  if (still) {
    return (
      <div
        aria-hidden="true"
        className="bg-background animate-out fade-out fill-mode-forwards fixed inset-0 z-100 delay-200 duration-500"
        onAnimationEnd={endReveal}
      />
    );
  }
  return (
    <DotsBuild
      className="pointer-events-none fixed inset-0 z-100 size-full"
      from={from}
      label={t`Opening Grasp`}
      onEnd={endReveal}
      ready={platformShows}
      root={pageOf}
      sketch
    />
  );
};
