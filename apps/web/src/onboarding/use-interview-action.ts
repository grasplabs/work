import { useRouter } from "@tanstack/react-router";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { useCoreAction } from "../use-core-action.ts";

/**
 * Runs one of staff's changes to the interviews (a reminder noted, a team
 * asked in, an interview deleted), then reads the page again, so what is
 * shown is what core now holds: `busy` meanwhile, and `failure` saying why
 * it didn't go through.
 */
export const useInterviewAction = () => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const act = (
    change: (staff: Session["onboardingStaff"]) => Promise<void>
  ): void => {
    void run(async (session) => {
      await changeThenRefresh(
        async () => {
          await change(session.onboardingStaff);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return { busy, failure, act };
};
