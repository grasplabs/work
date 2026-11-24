import { oauthProviderSchema } from "@grasp-os/shared/connect-names";
import { directorySuiteSchema } from "@grasp-os/shared/directory";
import type { OnboardingDirectory } from "@grasp-os/shared/directory";
import type { OnboardingPlaces } from "@grasp-os/shared/document-places";
import type { OnboardingHr } from "@grasp-os/shared/hr";
import type {
  LinkToSend,
  OnboardingReview,
  OnboardingView,
} from "@grasp-os/shared/onboarding";
import type { SetupChoices } from "@grasp-os/shared/onboarding-choices";
import type { OnboardingDocument } from "@grasp-os/shared/onboarding-documents";
import { flowScreens } from "@grasp-os/shared/onboarding-flow";
import type {
  OnboardingFlow,
  SetupPlace,
} from "@grasp-os/shared/onboarding-flow";
import type { GateView } from "@grasp-os/shared/onboarding-gate";
import type { Organization } from "@grasp-os/shared/organization";
import { isAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import {
  createFileRoute,
  Navigate,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { loadCoreStatus } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { PageError } from "../frame/page-states.tsx";
import { loadFromCore, notLoadedText } from "../load-from-core.tsx";
import { CalmFrame } from "../onboarding/calm-frame.tsx";
import type { Ways } from "../onboarding/calm-frame.tsx";
import { CampaignFrame } from "../onboarding/campaign/campaign-page.tsx";
import { isCampaignState } from "../onboarding/campaign/fixtures.ts";
import type { CampaignState } from "../onboarding/campaign/fixtures.ts";
import { poses } from "../onboarding/field/poses.ts";
import { todayInUtc } from "../onboarding/send-plan.ts";
import { SetupStepBody } from "../onboarding/setup-steps.tsx";
import {
  finishedAt,
  waysFrom,
  isReviewItem,
  isStep,
  keptAt,
  reachedByPlace,
  reachedOf,
  settledAs,
  stepIndex,
  stepShown,
  steps,
  suitesFor,
} from "../onboarding/setup.ts";
import type {
  AiReadiness,
  Kept,
  ReviewItemId,
  SetupPath,
  SetupStep,
} from "../onboarding/setup.ts";
import { smoothly } from "../onboarding/smoothly.ts";
import { signInErrorSearch } from "../sign-in-errors.ts";
import { useCore } from "../use-core.ts";

/** The suites whose directory the company step offers, in order. */
const directorySuites = directorySuiteSchema.options;

/**
 * Screens core's flow may still list that the setup no longer shows:
 * Pulse, on the work laptops, is set up with the company outside it.
 */
const dropped: ReadonlySet<SetupStep> = new Set(["pulse"]);

/** Where this browser keeps how far its admin went, the message they wrote and what they settled: a convenience of this browser alone. */
const keptKey = (userId: string): string => `grasp.setup.${userId}`;

/** Which list of steps a kept place counts in: core keeps the place by the screens' names, this browser only the message and what was settled. */
const keptSteps = 3;

const readKept = (userId: string): Kept => {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(keptKey(userId)) ?? "null"
    );
    if (typeof raw !== "object" || raw === null) {
      return { reached: 0, message: null, settled: [] };
    }
    const message =
      "message" in raw && typeof raw.message === "string" ? raw.message : null;
    const settled =
      "settled" in raw && Array.isArray(raw.settled)
        ? raw.settled.filter(isReviewItem)
        : [];
    return { reached: 0, message, settled };
  } catch {
    return { reached: 0, message: null, settled: [] };
  }
};

const writeKept = (userId: string, kept: Kept): void => {
  try {
    localStorage.setItem(
      keptKey(userId),
      JSON.stringify({ ...kept, steps: keptSteps })
    );
  } catch {
    // Kept only while the page is open.
  }
};

/**
 * Tells core the screens the admin `finished`. Not heard this once, core
 * hears it with the next screen: nothing is lost, and nothing holds the
 * admin up.
 */
const notePlace = async (
  core: ReturnType<typeof useCore>,
  finished: SetupStep[]
): Promise<void> => {
  try {
    await core.withSession(
      async (session) => await session.onboarding.finishSteps(finished)
    );
  } catch {
    // Said again with the next screen.
  }
};

/**
 * How far the admin went on this path, the message they wrote and what
 * they settled: the furthest step is remembered as they go, so going back
 * never lowers it and StepperNav's Next goes on as far as they went.
 */
const useKept = (userId: string, index: number, path: SetupPath) => {
  const [kept, setKept] = useState(() => readKept(userId));
  // A place counted on another path means nothing on this one.
  const [counted, setCounted] = useState(path);
  if (counted !== path) {
    setCounted(path);
  }
  const now = keptAt(counted === path ? kept : { ...kept, reached: 0 }, index);
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

/** The frame's arrows on a step: back a step, and on as far as they went; none on the campaign page or the end. */
const waysOf = (
  index: number,
  reached: number,
  path: SetupPath,
  go: (step: SetupStep) => void
): Ways | undefined => {
  const { back, on } = waysFrom(index, reached, path);
  const step = path[index];
  const ends = step === "listening" || step === "open";
  const ways: Ways = {
    onBack:
      back === undefined
        ? undefined
        : () => {
            go(back);
          },
    onNext:
      on === undefined || on === "listening" || on === "open"
        ? undefined
        : () => {
            go(on);
          },
  };
  return ends ? undefined : ways;
};

const Setup = () => {
  const { i18n } = useLingui();
  const navigate = useNavigate();
  const { identity, signIn, suites } = Route.useRouteContext();
  const loaded = Route.useLoaderData();
  const { step: asked, state: campaignState } = Route.useSearch();
  const data = loaded.state === "ready" ? loaded.data : null;
  // The screens this company's flow has, in its order; all of them where core can't say.
  // The same list while the flow is the same, so what goes by it runs once per change.
  const screens: SetupPath = (
    data === null ? steps : flowScreens(data.flow)
  ).filter((each) => !dropped.has(each));
  const [path, setPath] = useState(screens);
  if (path.join(",") !== screens.join(",")) {
    setPath(screens);
  }
  const plan = data?.view.plan ?? null;
  const placed = reachedByPlace(data?.place ?? null, path);
  const ai = data?.ai ?? null;
  // Opened without a step, it goes on where they were; never past the AI step while no model is ready for calls.
  const step = stepShown(asked, reachedOf(placed, { plan }, path), ai, path);
  const at = stepIndex(step, path);
  // Off the path (it can't be, once shown): the first screen.
  const index = Math.max(0, at);
  const kept = useKept(identity.userId, Math.max(index, placed), path);
  // Core hears of every screen they finished, so they go on from it anywhere, and Grasp sees how far they are.
  const core = useCore();
  useEffect(() => {
    if (kept.reached > placed) {
      void notePlace(core, finishedAt(kept.reached, path));
    }
  }, [core, kept.reached, placed, path]);
  const furthest = reachedOf(kept.reached, { plan }, path);
  // Where they were going: past this screen when the setup held them here on the way.
  const askedFor = Math.max(
    index,
    asked === undefined ? -1 : stepIndex(asked, path)
  );
  // Every screen settles into the next in one quiet fade; over once the screen is there.
  const turnTo = async (next: SetupStep): Promise<void> => {
    await smoothly(async () => {
      await navigate({ to: "/setup", search: { step: next } });
    });
  };
  const go = (next: SetupStep) => {
    void turnTo(next);
  };
  // The screen after this one; past the last, every screen is finished and the admin is in the platform.
  const onward = async (): Promise<void> => {
    const next = path[index + 1];
    if (next !== undefined) {
      await turnTo(next);
      return;
    }
    await notePlace(core, [...path]);
    await navigate({ to: "/" });
  };

  if (data === null) {
    return <PageError reason={notLoadedText(loaded, i18n) ?? ""} />;
  }
  // A company that goes through no onboarding has no screens: home.
  if (path.length === 0) {
    return <Navigate replace to="/" />;
  }
  // While the interviews run: the campaign page, from fixtures until core plans a campaign.
  // (Pulse is never on the path; named here so the steps below know they are the setup's.)
  if (step === "listening" || step === "pulse") {
    return <CampaignFrame state={campaignState ?? "day3"} />;
  }
  return (
    <CalmFrame
      userId={identity.userId}
      ways={waysOf(index, furthest, path, go)}
      centred={step === "open"}
      language={step !== "welcome"}
      pose={poses[step]}
    >
      <SetupStepBody
        data={{
          ...data,
          admin: identity.name.trim().split(/\s+/u)[0] ?? "",
          sendingDomain: data.view.mailDomain,
          signIn,
          // The sign-ins the kickoff named, where it named any.
          suites: suitesFor(suites, data.view.context),
          identity,
        }}
        askedFor={askedFor}
        go={go}
        key={step}
        message={kept.message}
        onMessage={(message) => {
          kept.onMessage(message);
        }}
        onSettle={(item, settled) => {
          kept.onSettle(item, settled);
        }}
        onward={onward}
        path={path}
        settled={kept.settled}
        step={step}
        today={todayInUtc()}
      />
    </CalmFrame>
  );
};

/**
 * The organization's name, for the message to the team; none when it has
 * none or core can't say, which leaves the rest of the onboarding as it is.
 */
const companyOf = async (
  organization: () => Promise<Organization>
): Promise<string | null> => {
  try {
    const { name } = await organization();
    return name.trim() === "" ? null : name;
  } catch {
    return null;
  }
};

/**
 * What Grasp's AI has to call, for the AI step: the providers an admin
 * can connect and those connected, and whether any model is ready for
 * calls (the models a chat may name); null when core can't say, which
 * leaves the rest of the onboarding as it is.
 */
const aiReadinessOf = async (session: Session): Promise<AiReadiness | null> => {
  try {
    const [listing, models] = await Promise.all([
      session.aiProviders.list(),
      session.chats.models(),
    ]);
    return { listing, ready: models.length > 0 };
  } catch {
    return null;
  }
};

/** What the onboarding reads from core. */
interface Loaded {
  /** The screens the admin finished, as core keeps them. */
  place: SetupPlace;
  /** How much onboarding the company goes through: its screens come from it. */
  flow: OnboardingFlow;
  view: OnboardingView;
  /** Everyone's own link to send, once it is out. */
  links: LinkToSend[];
  documents: OnboardingDocument[];
  gate: GateView;
  choices: SetupChoices;
  /** The steps people told two ways and nobody could explain, and how much of the work is mapped. */
  review: OnboardingReview;
  /** The organization's name, as the message to the team is addressed; null when it has none. */
  company: string | null;
  directory: OnboardingDirectory | null;
  places: OnboardingPlaces | null;
  hr: OnboardingHr | null;
  /** What Grasp's AI has to call; null when core can't say. */
  ai: AiReadiness | null;
}

export const Route = createFileRoute("/setup")({
  // `connection`: a connection's flow, started on a step, came back to it.
  validateSearch: (
    search: Record<string, unknown>
  ): {
    step?: SetupStep;
    connection?: string;
    state?: CampaignState;
  } => ({
    ...(isStep(search.step) && { step: search.step }),
    ...(isCampaignState(search.state) && { state: search.state }),
    ...(typeof search.connection === "string" && {
      connection: search.connection,
    }),
  }),
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
    // Grasp's staff work from the admin dashboard, from a saved /setup
    // link too (routes/staff.tsx).
    if (identity.staff) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/staff", replace: true });
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
    // The suites people sign in with here: their directories, and where their documents live, can be connected.
    const suites = directorySuites.filter((suite) =>
      signInOptions.some(({ providerId }) => providerId === suite)
    );
    return { identity, signIn, suites };
  },
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session): Promise<Loaded> => {
      const [
        view,
        links,
        documents,
        gate,
        choices,
        company,
        directory,
        places,
        review,
        hr,
        ai,
        place,
        flow,
      ] = await Promise.all([
        session.onboarding.view(),
        session.onboarding.links(),
        session.onboarding.documents(),
        session.onboardingGate.view(),
        session.onboarding.choices(),
        companyOf(async () => await session.organization.get()),
        session.onboarding.directory(),
        session.onboarding.documentPlaces(),
        session.onboarding.review(),
        session.onboarding.hrPlatform(),
        aiReadinessOf(session),
        session.onboarding.place(),
        session.onboarding.flow(),
      ]);
      return {
        view,
        links,
        documents,
        gate,
        choices,
        company,
        directory,
        places,
        review,
        hr,
        ai,
        place,
        flow,
      };
    }),
  component: Setup,
});
