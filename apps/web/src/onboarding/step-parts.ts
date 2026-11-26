import type { OAuthProvider } from "@grasp-os/shared/connect";
import type {
  DirectorySuite,
  OnboardingDirectory,
} from "@grasp-os/shared/directory";
import type { OnboardingPlaces } from "@grasp-os/shared/document-places";
import type {
  LinkToSend,
  OnboardingReview,
  OnboardingView,
} from "@grasp-os/shared/onboarding";
import type { SetupChoices } from "@grasp-os/shared/onboarding-choices";
import type { OnboardingDocument } from "@grasp-os/shared/onboarding-documents";
import type { GateView } from "@grasp-os/shared/onboarding-gate";
import type { Identity } from "@grasp-os/shared/rpc";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { useRouter } from "@tanstack/react-router";
import { z } from "zod";

import { GoogleLogo, MicrosoftLogo } from "../connections/brand-logos.ts";
import type {
  AiReadiness,
  ReviewItemId,
  SetupPath,
  SetupStep,
} from "./setup.ts";

// What every step of the setup is given, and the few things more than
// one step uses (setup-steps.tsx and the *-step.tsx files).

/** What the setup reads from core, and who is going through it. */
export interface SetupData {
  /** The admin's first name. */
  admin: string;
  /** The organization's name, as the message to the team is addressed; null when it has none. */
  company: string | null;
  view: OnboardingView;
  /** Everyone's own link to send, once it is out. */
  links: LinkToSend[];
  documents: OnboardingDocument[];
  gate: GateView;
  /** The directory connected for the onboarding; null before one is. */
  directory: OnboardingDirectory | null;
  /** The suites this deployment signs in with, whose directory and documents can be connected. */
  suites: DirectorySuite[];
  /** Where the documents live, connected for the onboarding; null before it is. */
  places: OnboardingPlaces | null;
  /** Grasp's sending domain (core's `MAIL_FROM`), which the admin lets through their mail filter; null while unset. */
  sendingDomain: string | null;
  /** The steps people told two ways and nobody could explain, and how much of the work is mapped. */
  review: OnboardingReview;
  /** What the admin chose about what Grasp may connect. */
  choices: SetupChoices;
  /** The suites the company signs in with. */
  signIn: OAuthProvider[];
  /** What Grasp's AI has to call; null when core can't say. */
  ai: AiReadiness | null;
  identity: Identity;
}

export interface StepProps {
  data: SetupData;
  /** Today, as an ISO date. */
  today: string;
  /** The message to the team, as the admin left it; null for the one drafted. */
  message: string | null;
  onMessage: (message: string) => void;
  /** What the admin settled of what needs them. */
  settled: ReviewItemId[];
  onSettle: (item: ReviewItemId, settled: boolean) => void;
  go: (step: SetupStep) => void;
  /** Goes on to the screen after this one on the company's path; past its last, into the platform. Over once that screen is there. */
  onward: () => Promise<void>;
  /** The screens this company's admin goes through, in order. */
  path: SetupPath;
  /** The step the admin asked for, by its place on the path: further on than this one when the setup held them here on the way. */
  askedFor: number;
}

/** Whether the admin has Grasp's mail to let through: it sends, from a sender core names. */
export const mailToLetThrough = (data: SetupData): boolean =>
  data.view.mailSends && data.sendingDomain !== null;

/** How each suite is named. Product names: not translated. */
export const suiteNames: Record<DirectorySuite, string> = {
  microsoft: "Microsoft",
  google: "Google",
};

/** Each suite's mark, as its own sign-in guidelines draw it. */
export const suiteLogos: Record<DirectorySuite, IconData> = {
  microsoft: MicrosoftLogo,
  google: GoogleLogo,
};

/** What a step's search says once a connection's flow came back to it. */
export const returnedSchema = z.object({ connection: z.string().min(1) });

/** Reads core again after a change, so every step shows what core now has. */
export const useRefresh = (): (() => Promise<void>) => {
  const router = useRouter();
  return async () => {
    await router.invalidate({ sync: true });
  };
};
