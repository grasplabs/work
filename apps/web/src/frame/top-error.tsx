import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { alertVars } from "@grasp-os/ui/components/alert.stylex";
import { Button } from "@grasp-os/ui/components/button";
import { Icon, XIcon } from "@grasp-os/ui/lib/icons";
import { duration, media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
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
// away until its words change. It stands above the header, in the page's
// flow, so it never covers anything: the page moves down with it, gently.

/** Something to do about it, beside its words: trying again, mostly. */
export interface TopErrorAction {
  label: string;
  run: () => Promise<void> | void;
}

interface Shown {
  /** Which one it is: each put is a new one. */
  id: number;
  title: string | undefined;
  message: string;
  action: TopErrorAction | undefined;
  onClose: (() => void) | undefined;
}

let made = 0;
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

/** Which error the bar shows now, by when it was put up: 0 while none shows. */
const newestId = (): number => newest()?.id ?? 0;

/** The newest error the bar shows, by when it was put up (0 while none): it grows as a new one shows, for Stephen to answer it in the setup (step-voice.tsx). */
export const useNewestError = (): number =>
  useSyncExternalStore(subscribe, newestId, newestId);

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

const put = (key: string, error: Omit<Shown, "id">): void => {
  made += 1;
  shown = [
    ...shown.filter((one) => one.key !== key),
    { key, error: { ...error, id: made } },
  ];
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
  // Above the header, across the whole window, as Damsko lays a banner over an app (app-shell-01):
  // a band with square ends, in the page's flow, so it never covers the header or the page. It
  // opens and closes by its height, gently, and the page moves down and back up with it.
  band: {
    display: "grid",
    gridTemplateRows: "0fr",
    flexShrink: 0,
    transitionProperty: {
      default: "grid-template-rows",
      [media.reducedMotion]: "none",
    },
    transitionDuration: duration.ui,
    transitionTimingFunction: duration.easeInOut,
    [alertVars.bannerCorner]: "0px",
  },
  open: { gridTemplateRows: "1fr" },
  inner: { minHeight: 0, overflow: "hidden" },
  alert: { width: "100%" },
  // Its close beside the words at their top end at every width, as an alert's own close stands:
  // never dropped under them on a phone, where Damsko puts an action that has no room.
  beside: {
    gridColumn: "2",
    gridRow: "1 / span 2",
    alignSelf: "start",
    marginBlockStart: `calc(-1 * ${space["1"]})`,
  },
});

/** The bar every error of the onboarding and the interview is said in: one per frame, at its top. */
export const TopErrorBar = () => {
  const { t } = useLingui();
  const error = useSyncExternalStore(subscribe, newest, newest);
  // Closed, it stays away until it is put there again: a new error, or the same one said anew.
  const [closed, setClosed] = useState<Shown | null>(null);
  const showing = error !== null && error !== closed;
  // What it said last stays in it while it closes, so it closes with its words, not empty.
  const [said, setSaid] = useState<Shown | null>(null);
  if (showing && said !== error) {
    setSaid(error);
  }
  // While it shows, Stephen's light behind the page turns red with it.
  useEffect(() => {
    alarm(showing);
    return () => {
      alarm(false);
    };
  }, [showing]);
  const close = (): void => {
    setClosed(error);
    error?.onClose?.();
  };
  return (
    <div
      data-slot="top-error"
      inert={!showing}
      {...stylex.props(styles.band, showing && styles.open)}
    >
      <div {...stylex.props(styles.inner)}>
        {said === null ? null : (
          <Alert
            appearance="banner"
            // Each error its own: a new one is said as it comes.
            key={said.id}
            style={styles.alert}
            variant="destructive"
          >
            {said.title === undefined ? null : (
              <AlertTitle>{said.title}</AlertTitle>
            )}
            <AlertDescription>{said.message}</AlertDescription>
            <AlertAction style={styles.beside}>
              {said.action === undefined ? null : (
                <Button
                  onClick={async () => {
                    setClosed(error);
                    await said.action?.run();
                  }}
                  size="xs"
                  variant="outline"
                >
                  {said.action.label}
                </Button>
              )}
              <Button
                aria-label={t`Close`}
                onClick={close}
                size="icon-xs"
                variant="ghost"
              >
                <Icon icon={XIcon} />
              </Button>
            </AlertAction>
          </Alert>
        )}
      </div>
    </div>
  );
};
