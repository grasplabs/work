import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { alarmField } from "../onboarding/field/engine.ts";

// Every error in the onboarding and the interview is said one way: in
// Damsko's banner, across the top of the window, never as red words in the
// page (the owner's rule: no exceptions). A screen says what went wrong
// with <TopError> where it would have written it; the frame it stands in
// shows it with <TopErrorBar>. The newest one shows; closing it puts it
// away until its words change. It lies over the page, so nothing under it
// moves when it comes or goes.

/** Something to do about it, beside its words: trying again, mostly. */
export interface TopErrorAction {
  label: string;
  run: () => Promise<void> | void;
}

interface Shown {
  title: string | undefined;
  message: string;
  action: TopErrorAction | undefined;
  onClose: (() => void) | undefined;
}

let shown: readonly { key: string; error: Shown }[] = [];
const listeners = new Set<() => void>();

const changed = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const newest = (): Shown | null => shown.at(-1)?.error ?? null;

/** Whether the bar shows an error now: what is drawn behind the page turns red with it. */
let alarmed = false;
const isAlarmed = (): boolean => alarmed;

/** Whether an error shows in the bar at the top now, for a dither of the page's own to turn red with it. */
export const useAlarmed = (): boolean =>
  useSyncExternalStore(subscribe, isAlarmed, isAlarmed);

const alarm = (on: boolean): void => {
  alarmed = on;
  alarmField(on);
  changed();
};

const put = (key: string, error: Shown): void => {
  shown = [...shown.filter((one) => one.key !== key), { key, error }];
  changed();
};

const take = (key: string): void => {
  shown = shown.filter((one) => one.key !== key);
  changed();
};

/**
 * Says what went wrong in the bar at the top, for as long as it stands
 * here with words; it draws nothing where it stands. A drop-in for
 * ErrorText: `<TopError>{failure}</TopError>`.
 */
export const TopError = ({
  children,
  title,
  action,
  onClose,
}: {
  /** What went wrong and what to do; nothing while all is well. */
  children?: string | null;
  /** What happened in a few words, over it: "Microsoft didn't connect". */
  title?: string;
  /** What they can do about it, as a button beside it. */
  action?: TopErrorAction;
  /** Runs when they close it, as well as putting it away. */
  onClose?: () => void;
}) => {
  const key = useId();
  const message = children ?? "";
  // What it does, as it is now: a screen makes these anew each time it draws, and that changes
  // nothing about what the bar says.
  const latest = useRef({ action, onClose });
  useEffect(() => {
    latest.current = { action, onClose };
  });
  const label = action?.label;
  useEffect(() => {
    if (message !== "") {
      put(key, {
        title,
        message,
        action:
          label === undefined
            ? undefined
            : { label, run: async () => await latest.current.action?.run() },
        onClose: () => {
          latest.current.onClose?.();
        },
      });
    }
    return () => {
      take(key);
    };
  }, [key, message, title, label]);
  return null;
};

const styles = stylex.create({
  // Across the top of the page, just under the header, so its controls stay clear and usable;
  // above everything on the page.
  bar: {
    position: "fixed",
    insetBlockStart: {
      default: `calc(4rem + ${space["2"]})`,
      [media.sm]: `calc(5rem + ${space["2"]})`,
    },
    insetInline: space["3"],
    zIndex: 50,
    display: "flex",
    justifyContent: "center",
    pointerEvents: "none",
  },
  // Its own box takes the pointer; the window's edges around it don't.
  hold: {
    display: "flex",
    width: "100%",
    maxWidth: "48rem",
    pointerEvents: "auto",
  },
  alert: { width: "100%" },
});

/** The bar every error of the onboarding and the interview is said in: one per frame. */
export const TopErrorBar = () => {
  const error = useSyncExternalStore(subscribe, newest, newest);
  // Closed, it stays away until it is put there again: a new error, or the same one said anew.
  const [closed, setClosed] = useState<Shown | null>(null);
  const showing = error !== null && error !== closed;
  // While it shows, Stephen's light behind the page turns red with it.
  useEffect(() => {
    alarm(showing);
    return () => {
      alarm(false);
    };
  }, [showing]);
  if (error === null || error === closed) {
    return null;
  }
  return (
    <div {...stylex.props(styles.bar)}>
      <div {...stylex.props(styles.hold)}>
        <Alert
          appearance="banner"
          onClose={() => {
            setClosed(error);
            error.onClose?.();
          }}
          style={styles.alert}
          variant="destructive"
        >
          {error.title === undefined ? null : (
            <AlertTitle>{error.title}</AlertTitle>
          )}
          <AlertDescription>{error.message}</AlertDescription>
          {error.action === undefined ? null : (
            <AlertAction>
              <Button
                onClick={async () => {
                  setClosed(error);
                  await error.action?.run();
                }}
                size="xs"
                variant="outline"
              >
                {error.action.label}
              </Button>
            </AlertAction>
          )}
        </Alert>
      </div>
    </div>
  );
};
