import { I18nProvider } from "@grasp-os/ui/lib/i18n";
import type { I18nCatalog } from "@grasp-os/ui/lib/i18n";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

import { formatList } from "../format.ts";

/** A length of time as the page's language says it: "1 minute and 5 seconds", "5 seconds". */
const spokenTime = (locale: string, seconds: number): string => {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const unit = (count: number, of: "hour" | "minute" | "second") =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit: of,
      unitDisplay: "long",
    }).format(count);
  return formatList(
    [
      hours > 0 ? unit(hours, "hour") : "",
      hours > 0 || minutes > 0 ? unit(minutes, "minute") : "",
      unit(whole % 60, "second"),
    ].filter((part) => part !== "")
  );
};

/**
 * The few words Damsko's components say themselves ("Copied", "Working"),
 * in the page's language. Damsko knows nothing of Lingui: its components
 * read their words from its own provider, which this fills from the
 * catalog, part by part. A part not given here keeps Damsko's English, so
 * each part gets its words in the pull request that first uses it.
 *
 * Inside Lingui's provider, once around the routes. Damsko's provider
 * keeps the words it has until the language or one of them changes.
 */
export const UiWords = ({ children }: { children: ReactNode }) => {
  const { t, i18n } = useLingui();
  const { locale } = i18n;
  const catalog: Partial<I18nCatalog> = {
    copyButton: {
      copied: t`Copied`,
      copy: t`Copy`,
      copyError: t`Not copied`,
    },
    menu: {
      error: t`Failed`,
      loading: t`Working`,
    },
    action: {
      agentAsks: t`Does something that needs your yes`,
      agentPresses: (words) => t`Presses "${words}"`,
      error: t`Could not finish`,
      loading: t`Working`,
      success: t`Done`,
    },
    alert: {
      close: t({ message: "Dismiss", context: "close a notice" }),
    },
    alertDialog: {
      cancel: t`Cancel`,
    },
    attachment: {
      remove: (name) => t`Remove ${name}`,
    },
    audioPlayer: {
      back: t`Back 10 seconds`,
      error: t`Could not play this file`,
      forward: t`Forward 10 seconds`,
      loading: t`Loading the sound`,
      pause: t`Pause`,
      play: t`Play`,
      playbackRate: t({ message: "Speed", context: "how fast a sound plays" }),
      position: t({ message: "Position", context: "where a sound is at" }),
      soundOn: t`Turn sound on`,
      soundOff: t`Turn sound off`,
      timeOf: (now, length) => {
        const at = spokenTime(locale, now);
        const of = spokenTime(locale, length);
        return t`${at} of ${of}`;
      },
    },
    holdButton: {
      ask: (words) => t`${words}?`,
      cancel: t`Cancel`,
      confirm: t`Confirm`,
      holdTo: (words) => t`Press and hold: ${words}`,
    },
    input: {
      hidePassword: t`Hide password`,
      replace: t({ message: "Replace", context: "type a new secret" }),
      showPassword: t`Show password`,
    },
    keyValue: {
      copy: (label) => t`Copy ${label}`,
      loading: t`Loading the value`,
    },
    message: {
      actions: t`Message actions`,
      assistant: t({ message: "Assistant", context: "who wrote a message" }),
      done: t`Answer ready`,
      error: t`Could not answer`,
      retry: t`Try again`,
      stopped: t({ message: "Stopped", context: "an answer stopped part way" }),
      streaming: t({ message: "Writing", context: "an answer being written" }),
      user: t({ message: "You", context: "who wrote a message" }),
    },
    messageScroller: {
      arrived: (count) =>
        plural(count, { one: "# new message", other: "# new messages" }),
      jumpToNew: (jumpLabel) => t`${jumpLabel}, new messages`,
      label: t`Messages`,
      loading: t`Loading the conversation`,
      scrollToEnd: t`Jump to latest`,
      scrollToStart: t`Jump to start`,
    },
    promptInput: {
      add: t`Add to message`,
      addAttachments: t`Add files`,
      attachments: t`Files to send`,
      count: (length, max) => `${length}/${max}`,
      cut: (max) =>
        max === 0
          ? t`What was added was left out: no more can be written`
          : plural(max, {
              one: "What was added was cut at the limit of # character",
              other: "What was added was cut at the limit of # characters",
            }),
      drop: t`Drop to add`,
      failed: t`Could not send. Your message is kept.`,
      mentionEmpty: t`No matches`,
      mentionsError: t`Could not load suggestions`,
      mentionsFound: (count) =>
        count === 0
          ? t`No results`
          : plural(count, { one: "# result", other: "# results" }),
      mentionsLoading: t({
        message: "Looking",
        context: "searching for suggestions",
      }),
      near: (max) =>
        max === 0
          ? t`No room left`
          : plural(max, {
              one: "Close to the limit of # character",
              other: "Close to the limit of # characters",
            }),
      reached: (max) =>
        max === 0
          ? t`No more can be written`
          : plural(max, {
              one: "The limit of # character is reached",
              other: "The limit of # characters is reached",
            }),
      speechButton: {
        cancel: t`Cancel dictation`,
        done: t({ message: "Done", context: "stop dictating" }),
        label: t`Dictate`,
        listening: t`Listening`,
        mute: t({
          message: "Mute",
          context: "turn your microphone off for a moment",
        }),
        settling: t`Writing it down`,
      },
      stop: t({ message: "Stop", context: "stop an answer" }),
      submit: t`Send`,
      succeeded: t`Done`,
      // Closing a spoken conversation gives the text back.
      voice: {
        close: t`Type instead`,
        label: t`Voice conversation`,
        listening: t`Listening`,
        speaking: t({ message: "Speaking", context: "the other voice's turn" }),
      },
    },
    sheet: {
      close: t`Close`,
    },
  };
  return (
    <I18nProvider catalog={catalog} locale={locale}>
      {children}
    </I18nProvider>
  );
};
