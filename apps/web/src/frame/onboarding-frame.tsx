import { GraspMark } from "@grasp-os/app-kit/components/grasp-mark";
import type { ReactNode } from "react";

import { LanguageButton } from "../language-picker.tsx";

/**
 * A page for someone outside the product (sign-in) in the
 * onboarding's frame (grasplabs/prototype
 * `components/onboarding/onboarding-frame.tsx`): one centred column, the
 * mark bottom left and the language bottom right.
 */
export const OnboardingFrame = ({ children }: { children: ReactNode }) => (
  <div className="bg-background flex min-h-svh flex-col text-sm">
    <div aria-hidden="true" className="h-18 flex-none" />
    <main className="flex flex-1 flex-col items-center px-4 py-2">
      <div className="my-auto flex w-full max-w-sm flex-col items-center gap-8 text-center">
        {children}
      </div>
    </main>
    <footer className="bg-background sticky bottom-0 flex h-18 flex-none items-center justify-between px-4 sm:px-10">
      <GraspMark className="size-5" />
      <LanguageButton />
    </footer>
  </div>
);
