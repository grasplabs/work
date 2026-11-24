import { useRef } from "react";

import { leaveToSignIn, signInAddress } from "../../core.ts";
import { useGone } from "../../use-gone.ts";

/**
 * Where the sign-in page leaves for at a press, asked of core then, so it
 * answers while the door opens (`ask`), and the leaving itself once the
 * door has opened (`leave`). Nothing leaves once the page has gone: a
 * person who went Back meanwhile stays where they went.
 */
export const useLeave = (returnTo: string) => {
  const gone = useGone();
  const asked = useRef<{
    address: Promise<string | null>;
    gone: AbortSignal;
  }>(null);
  /** Asks core where provider `provider` signs in. */
  const ask = (provider: string): void => {
    asked.current = {
      address: (async () => {
        try {
          return await signInAddress(provider, returnTo);
        } catch {
          return null;
        }
      })(),
      gone: gone(),
    };
  };
  /** Leaves for the identity provider core gave; `refused` when the sign-in didn't start. */
  const leave = async (refused: () => void): Promise<void> => {
    const pending = asked.current;
    const address = await pending?.address;
    if (pending?.gone.aborted === true) {
      return;
    }
    if (address === undefined || address === null) {
      refused();
      return;
    }
    leaveToSignIn(address);
  };
  return { ask, leave };
};
