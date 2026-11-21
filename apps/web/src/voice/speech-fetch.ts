import { interviewLocaleSchema } from "@grasp-os/shared/onboarding";
import { i18n } from "@lingui/core";

// What the onboarding's voice (voice.ts) and the interview's
// (interview/speech.ts) share in fetching a line from core's speech.

/**
 * How many lines are fetched ahead at once: the voice refuses many more.
 * The line about to be said never waits behind them.
 */
const fetchesAtOnce = 2;

/** The page's language, as the voice takes it. */
export const languageNow = () => {
  const parsed = interviewLocaleSchema.safeParse(i18n.locale);
  return parsed.success ? parsed.data : "en";
};

export const bytesOf = (base64: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(base64), (char) => char.codePointAt(0) ?? 0);

/**
 * A queue of fetches: `inTurn` runs a task in its turn, or at once when
 * `now`; `hurry` sends a task waiting its turn now, as it is about to be
 * said.
 */
export const fetchTurns = <Clip>() => {
  const queued: { key: string; start: () => void }[] = [];
  let fetching = 0;

  const nextFetch = (): void => {
    for (const turn of queued.splice(
      0,
      Math.max(fetchesAtOnce - fetching, 0)
    )) {
      turn.start();
    }
  };

  const inTurn = async (
    key: string,
    task: () => Promise<Clip>,
    now: boolean
  ): Promise<Clip> => {
    const { promise, resolve } = Promise.withResolvers<Clip>();
    const start = async (): Promise<void> => {
      fetching += 1;
      try {
        resolve(await task());
      } finally {
        fetching -= 1;
        nextFetch();
      }
    };
    if (now || fetching < fetchesAtOnce) {
      void start();
    } else {
      queued.push({
        key,
        start: () => {
          void start();
        },
      });
    }
    return await promise;
  };

  const hurry = (key: string): void => {
    const at = queued.findIndex((each) => each.key === key);
    const [turn] = at === -1 ? [] : queued.splice(at, 1);
    turn?.start();
  };

  return { inTurn, hurry };
};
