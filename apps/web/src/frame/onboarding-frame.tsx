import type { ReactNode } from "react";

import { GraspMark } from "../grasp-mark.tsx";
import { LanguageButton } from "../language-picker.tsx";

/**
 * A page for someone outside the product (sign-in, a guest's chat) in the
 * onboarding's frame (grasplabs/prototype
 * `components/onboarding/onboarding-frame.tsx`): one centred column, the
 * mark bottom left and the language bottom right. `wide` holds a chat.
 */
export const OnboardingFrame = ({
  children,
  wide = false,
}: {
  children: ReactNode;
  wide?: boolean;
}) => (
  <div className="bg-background flex min-h-svh flex-col text-sm">
    <div aria-hidden="true" className="h-18 flex-none" />
    <main className="flex flex-1 flex-col items-center px-4 py-2">
      <div
        className={
          wide
            ? "my-auto flex w-full max-w-2xl flex-col items-center gap-8"
            : "my-auto flex w-full max-w-sm flex-col items-center gap-8 text-center"
        }
      >
        {children}
      </div>
    </main>
    <footer className="bg-background sticky bottom-0 flex h-18 flex-none items-center justify-between px-4 sm:px-10">
      <GraspMark className="text-foreground size-5" />
      <LanguageButton />
    </footer>
  </div>
);
