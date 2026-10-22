import { oauthProviderSchema } from "@grasp-os/shared/connect";
import type { OnboardingView } from "@grasp-os/shared/onboarding";
import { noChoices } from "@grasp-os/shared/onboarding-choices";
import type { SetupChoices } from "@grasp-os/shared/onboarding-choices";
import type { OnboardingDocument } from "@grasp-os/shared/onboarding-documents";
import type { GateView } from "@grasp-os/shared/onboarding-gate";
import { isAdmin } from "@grasp-os/shared/roles";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { DotBrain } from "../brain/dot-brain.tsx";
import type { BrainScene } from "../brain/dot-brain.tsx";
import { loadCoreStatus } from "../core-connection.ts";
import { PageError } from "../frame/page-states.tsx";
import { loadFromCore, notLoadedText } from "../load-from-core.tsx";
import { SetupFrame } from "../onboarding/setup-frame.tsx";
import { SetupStepBody } from "../onboarding/setup-steps.tsx";
import {
  brainScene,
  isReviewItem,
  isStep,
  keptAt,
  listeningOf,
  reachedOf,
  sendingDomainOf,
  settledAs,
  stepIndex,
  steps,
} from "../onboarding/setup.ts";
import type { Kept, ReviewItemId, SetupStep } from "../onboarding/setup.ts";
import { signInErrorSearch } from "../sign-in-errors.ts";
import { resumeVoice, stopSpeaking, voiceLevel } from "../voice/voice.ts";

// The client onboarding (prototype `routes/onboarding.tsx`): what a
// company's admin goes through until Grasp opens, full screen and outside
// the app. The brain on top, taking a new figure for each step, and one
// step at a time below it, each fading in; the step is in the address, so
// the browser's back and forward work too. Stephen says each step as it
// arrives (setup-parts.tsx). Admins only: core refuses
// everyone else, and anyone else is taken home. Grasp's staff have their
// own side of it at /onboarding.

/** How wide the column is by step, and how large the brain: roomier where there is more to read. */
const layout: Record<SetupStep, { width: string; brain: number }> = {
  welcome: { width: "max-w-120", brain: 400 },
  about: { width: "max-w-140", brain: 340 },
  company: { width: "max-w-110", brain: 420 },
  sources: { width: "max-w-150", brain: 260 },
  documents: { width: "max-w-150", brain: 260 },
  pulse: { width: "max-w-140", brain: 240 },
  leads: { width: "max-w-140", brain: 260 },
  team: { width: "max-w-130", brain: 270 },
  listening: { width: "max-w-140", brain: 300 },
  review: { width: "max-w-110", brain: 330 },
  open: { width: "max-w-110", brain: 450 },
};

/** The brain's sizes, by ten pixels: a class each, as a class is never built from a number. */
const brainSizes: Record<number, string> = {
  120: "size-30",
  130: "size-32.5",
  140: "size-35",
  150: "size-37.5",
  160: "size-40",
  170: "size-42.5",
  180: "size-45",
  190: "size-47.5",
  200: "size-50",
  210: "size-52.5",
  220: "size-55",
  230: "size-57.5",
  240: "size-60",
  250: "size-62.5",
  260: "size-65",
  270: "size-67.5",
  280: "size-70",
  290: "size-72.5",
  300: "size-75",
  310: "size-77.5",
  320: "size-80",
  330: "size-82.5",
  340: "size-85",
  350: "size-87.5",
  360: "size-90",
  370: "size-92.5",
  380: "size-95",
  390: "size-97.5",
  400: "size-100",
  410: "size-102.5",
  420: "size-105",
  430: "size-107.5",
  440: "size-110",
  450: "size-112.5",
};

/** What stands around the brain and a step, in pixels: the frame's top and bottom, its own margins, and the room between the brain and the step. */
const around = 190;
/** The smallest the brain gets to make room, and the steps it gives way in, so it does not flutter as a line comes and goes. */
const brainLeast = 120;
const brainStep = 20;

const onResize = (listener: () => void): (() => void) => {
  window.addEventListener("resize", listener);
  return () => {
    window.removeEventListener("resize", listener);
  };
};

/** Where this browser keeps how far its admin went, the message they wrote and what they settled: a convenience of this browser alone. */
const keptKey = (userId: string): string => `grasp.setup.${userId}`;

const readKept = (userId: string): Kept => {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(keptKey(userId)) ?? "null"
    );
    if (typeof raw !== "object" || raw === null) {
      return { reached: 0, message: null, settled: [] };
    }
    const reached =
      "reached" in raw && typeof raw.reached === "number" ? raw.reached : 0;
    const message =
      "message" in raw && typeof raw.message === "string" ? raw.message : null;
    const settled =
      "settled" in raw && Array.isArray(raw.settled)
        ? raw.settled.filter(isReviewItem)
        : [];
    return { reached, message, settled };
  } catch {
    return { reached: 0, message: null, settled: [] };
  }
};

const writeKept = (userId: string, kept: Kept): void => {
  try {
    localStorage.setItem(keptKey(userId), JSON.stringify(kept));
  } catch {
    // Kept only while the page is open.
  }
};

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * How far this browser's admin went, the message they wrote and what they
 * settled: the furthest step is remembered as they go, so the dots and the
 * arrow keys go on as far as they went.
 */
const useKept = (userId: string, index: number) => {
  const [kept, setKept] = useState(() => readKept(userId));
  // The furthest step is kept as they go, so going back never lowers it.
  const now = keptAt(kept, index);
  if (now !== kept) {
    setKept(now);
  }
  useEffect(() => {
    writeKept(userId, now);
  }, [userId, now]);
  return {
    reached: now.reached,
    message: now.message,
    settled: now.settled,
    onMessage: (next: string) => {
      setKept({ ...now, message: next });
    },
    onSettle: (item: ReviewItemId, settled: boolean) => {
      setKept(settledAs(now, item, settled));
    },
  };
};

/** The arrow keys go back, and forward as far as you have been, unless you are typing. */
const useArrowKeys = (
  index: number,
  reached: number,
  go: (step: SetupStep) => void
): void => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { target } = event;
      const typing =
        target instanceof Element &&
        target.closest(
          'input, textarea, [contenteditable="true"], [role="radiogroup"], [role="group"]'
        ) !== null;
      if (typing || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const back = steps[index - 1];
      const on = steps[index + 1];
      if (event.key === "ArrowLeft" && back !== undefined) {
        go(back);
      }
      if (event.key === "ArrowRight" && on !== undefined && index < reached) {
        go(on);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [index, reached, go]);
};

/**
 * A step never needs scrolling: the brain takes what the window leaves
 * once the step itself has its room, down to a small one, in steps, so it
 * does not flutter as a line comes and goes. On a phone a step that does
 * not fit even beside the smallest brain is cramped: its sentence makes way
 * once read, and where that frees too little, the brain makes way with it,
 * until the next step.
 */
const useBrainRoom = (step: SetupStep) => {
  const body = useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = useState(0);
  useEffect(() => {
    const element = body.current;
    const observer = new ResizeObserver(([entry]) => {
      setBodyHeight(entry?.contentRect.height ?? 0);
    });
    if (element !== null) {
      observer.observe(element);
    }
    return () => {
      observer.disconnect();
    };
  }, []);
  const windowHeight = useSyncExternalStore(
    onResize,
    () => window.innerHeight,
    () => 1000
  );
  const phone = useSyncExternalStore(
    onResize,
    () => !window.matchMedia("(min-width: 40rem)").matches,
    () => false
  );
  const [brainAway, setBrainAway] = useState<SetupStep | null>(null);
  if (brainAway !== null && brainAway !== step) {
    setBrainAway(null);
  }
  /** The room the brain has beside a step this high. */
  const roomBeside = (height: number) => windowHeight - around - height;
  const room = Math.floor(roomBeside(bodyHeight) / brainStep) * brainStep;
  const measured = bodyHeight > 0;
  const wanted = layout[step].brain;
  let brain = wanted;
  if (brainAway === step) {
    brain = 0;
  } else if (measured) {
    brain = Math.max(brainLeast, Math.min(wanted, room));
  }
  return {
    body,
    cramped: phone && measured && roomBeside(bodyHeight) < brainLeast,
    brainSize: brainSizes[Math.round(brain / 10) * 10],
    onMadeWay: (freed: number) => {
      if (roomBeside(bodyHeight - freed) < brainLeast) {
        setBrainAway(step);
      }
    },
  };
};

/**
 * Leaving the onboarding, Stephen stops mid-sentence rather than talk over
 * the app; every step that follows is a new start, so a pause from the
 * last one lets go.
 */
const useVoiceBetweenSteps = (step: SetupStep): void => {
  useEffect(
    () => () => {
      stopSpeaking();
      resumeVoice();
    },
    []
  );
  const last = useRef(step);
  useEffect(() => {
    if (last.current !== step) {
      last.current = step;
      resumeVoice();
    }
  }, [step]);
};

/** What the steps read of what was loaded, or nothing while it could not be. */
const readOf = (data: Loaded | null) => ({
  roster: data?.view.roster ?? null,
  plan: data?.view.plan ?? null,
  progress: data?.view.progress ?? null,
  percent: data?.gate.known ?? 0,
  parts: data?.gate.parts ?? [],
  choices: data?.choices ?? noChoices,
});

const Setup = () => {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const { identity, signIn } = Route.useRouteContext();
  const loaded = Route.useLoaderData();
  const { step: asked } = Route.useSearch();
  const data = loaded.state === "ready" ? loaded.data : null;
  const { roster, plan, progress, percent, parts, choices } = readOf(data);
  const stored = readKept(identity.userId).reached;
  // Opened without a step, it goes on where they were.
  const step: SetupStep =
    asked ?? steps[reachedOf(stored, { plan })] ?? "welcome";
  const index = stepIndex(step);
  const kept = useKept(identity.userId, index);
  const reached = reachedOf(kept.reached, { plan });
  const now = today();
  const listening = listeningOf({ roster, plan, progress }, now);
  // "How this works" tells its story in the brain's figures, so the figure follows the story there.
  const [story, setStory] = useState<BrainScene | null>(null);
  const told = brainScene(step, {
    roster,
    listening,
    known: percent,
    choices,
  });
  const scene = step === "about" && story !== null ? story : told;
  const go = (next: SetupStep) => {
    void navigate({ to: "/setup", search: { step: next } });
  };
  useArrowKeys(index, reached, go);
  useVoiceBetweenSteps(step);
  const { body, cramped, brainSize, onMadeWay } = useBrainRoom(step);

  if (data === null) {
    return <PageError reason={notLoadedText(loaded, i18n) ?? ""} />;
  }
  const admin = identity.name.split(" ")[0] ?? identity.name;
  const sendingDomain = sendingDomainOf(window.location.hostname);
  return (
    <SetupFrame
      knowledge={{ parts, percent, threshold: data.gate.threshold }}
      onExit={() => {
        void navigate({ to: "/" });
      }}
      onGo={go}
      reached={reached}
      step={step}
    >
      <div
        className={cn(
          "flex w-full flex-col items-center gap-6 text-center transition-all duration-500",
          layout[step].width
        )}
      >
        <div className="flex flex-col items-center gap-1.5">
          {/* The brain fades with the step it belongs to; making way, it folds up as it fades. */}
          {brainSize === undefined ? null : (
            <div className="animate-in fade-in fill-mode-backwards overflow-hidden delay-300 duration-500">
              <DotBrain
                className={cn("transition-all duration-500", brainSize)}
                label={t`The company brain: ${percent}% known. Dark dots are what I know, grey dots what I still need to learn.`}
                scene={scene}
                voice={voiceLevel}
              />
            </div>
          )}
        </div>
        {/* One step fades out, the next fades in: nothing slides. */}
        <div className="flex w-full flex-col items-center" ref={body}>
          <div
            className="animate-in fade-in flex w-full flex-col items-center gap-6 duration-500"
            key={step}
          >
            <SetupStepBody
              cramped={cramped}
              data={{ ...data, admin, sendingDomain, signIn, identity }}
              go={go}
              listening={listening}
              message={kept.message}
              onMadeWay={onMadeWay}
              onMessage={(message) => {
                kept.onMessage(message);
              }}
              onSettle={(item, settled) => {
                kept.onSettle(item, settled);
              }}
              onStory={setStory}
              parts={parts}
              percent={percent}
              settled={kept.settled}
              step={step}
              today={now}
            />
          </div>
        </div>
      </div>
    </SetupFrame>
  );
};

/** What the onboarding reads from core. */
interface Loaded {
  view: OnboardingView;
  documents: OnboardingDocument[];
  gate: GateView;
  choices: SetupChoices;
}

export const Route = createFileRoute("/setup")({
  validateSearch: (search: Record<string, unknown>): { step?: SetupStep } =>
    isStep(search.step) ? { step: search.step } : {},
  beforeLoad: async ({ context: { core }, location }) => {
    const { connected, identity, signInOptions } = await loadCoreStatus(core);
    if (!connected) {
      throw new Error("Grasp can't be reached right now.");
    }
    if (identity === undefined) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({
        to: "/sign-in",
        search: {
          returnTo: location.pathname,
          ...signInErrorSearch(location.search),
        },
      });
    }
    if (!isAdmin(identity.role)) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/", replace: true });
    }
    // The suites the company signs in with: their places where documents live come first.
    const signIn = signInOptions.flatMap(({ providerId }) => {
      const suite = oauthProviderSchema.safeParse(providerId);
      return suite.success ? [suite.data] : [];
    });
    return { identity, signIn };
  },
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session): Promise<Loaded> => {
      const [view, documents, gate, choices] = await Promise.all([
        session.onboarding.view(),
        session.onboarding.documents(),
        session.onboardingGate.view(),
        session.onboarding.choices(),
      ]);
      return { view, documents, gate, choices };
    }),
  component: Setup,
});
