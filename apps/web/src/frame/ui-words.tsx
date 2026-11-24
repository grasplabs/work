import { I18nProvider } from "@grasp-os/ui/lib/i18n";
import type { I18nCatalog } from "@grasp-os/ui/lib/i18n";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

/**
 * A kind of file a FileUpload takes, as its `accept` gives it, said as a
 * person reads it: an extension in capitals (".pdf" PDF), a type by its
 * subtype ("image/png" PNG), a family of them by its family ("image/*").
 */
const fileType = (type: string, family: (kind: string) => string): string => {
  const [kind = "", sub] = type.split("/");
  if (sub === undefined) {
    return kind.replace(/^\./u, "").toUpperCase();
  }
  return sub === "*" ? family(kind) : (sub.split("+")[0] ?? sub).toUpperCase();
};

/** Words in a list, the last after the language's "or": "PDF, PNG or JPG". */
const orList = (words: readonly string[], locale: string): string =>
  new Intl.ListFormat(locale, { type: "disjunction" }).format(words);

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
  const catalog: Partial<I18nCatalog> = {
    copyButton: {
      copied: t`Copied`,
      copy: t`Copy`,
      copyError: t`Not copied`,
    },
    menu: {
      // On a menu item, and said, when the work it started failed; not a
      // run's status, which other languages word otherwise.
      error: t({ message: "Failed", context: "a menu item whose work failed" }),
      loading: t`Working`,
    },
    holdButton: {
      ask: (words) => t`${words}?`,
      cancel: t`Cancel`,
      confirm: t`Confirm`,
      holdTo: (words) => t`Press and hold: ${words}`,
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
    action: {
      agentAsks: t`Does something that needs your yes`,
      agentPresses: (words) => t`Presses "${words}"`,
      error: t`Could not finish`,
      loading: t`Working`,
      success: t`Done`,
    },
    alertDialog: {
      cancel: t`Cancel`,
    },
    breadcrumb: {
      ellipsis: t`Show hidden levels`,
      name: t`Breadcrumb`,
    },
    calendar: {
      next: t`Next month`,
      previous: t`Previous month`,
    },
    datePicker: {
      last30: t`Last 30 days`,
      last7: t`Last 7 days`,
      presets: t`Presets`,
      rangeEnd: (field) => t`${field}, end`,
      rangeStart: (field) => t`${field}, start`,
      rangeTrigger: t`Choose dates`,
      select: t`Choose date`,
      triggerWith: (trigger, chosen) => t`${trigger}, ${chosen}`,
      thisMonth: t`This month`,
      today: t`Today`,
    },
    dialog: {
      close: t`Close`,
    },
    dropdownMenu: {
      expand: t`More actions`,
    },
    empty: {
      error: t`This did not load`,
    },
    fileUpload: {
      added: (count) =>
        plural(count, { one: "# file added", other: "# files added" }),
      doneLine: (size) => t`${size}, uploaded`,
      drop: t`Drop files here, or`,
      error: t`Could not upload`,
      files: t`Files`,
      limits: (types, maxSize) => {
        const kinds = orList(
          types.map((type) => fileType(type, (kind) => t`${kind} files`)),
          i18n.locale
        );
        if (maxSize === undefined) {
          return kinds;
        }
        return kinds === ""
          ? t`Up to ${maxSize}`
          : t`${kinds}, up to ${maxSize}`;
      },
      notSent: (name) => t`Could not upload ${name}.`,
      refused: (name, reason) =>
        ({
          "file-type": t`${name} is not a kind of file this takes.`,
          "file-too-large": t`${name} is too large.`,
          "file-too-small": t`${name} is empty.`,
          "too-many-files": t`${name} is one file too many.`,
        })[reason] ?? t`${name}: ${reason}`,
      remove: (name) => t`Remove ${name}`,
      removed: (names) => {
        const [only] = names;
        const count = names.length;
        return count === 1 && only !== undefined
          ? t`${only} removed`
          : plural(count, { one: "# file removed", other: "# files removed" });
      },
      retry: t`Try again`,
      select: t`Choose files`,
      sent: (name) => t`${name} uploaded.`,
      uploading: (percent) => t`Uploading, ${percent}%`,
      uploadingName: (name) => t`Uploading ${name}`,
    },
    input: {
      hidePassword: t`Hide password`,
      replace: t`Replace`,
      showPassword: t`Show password`,
    },
    keyValue: {
      // A fact's name inside the sentence, lower case, but for German, whose
      // nouns keep their capital.
      copy: (fact) => {
        const label =
          i18n.locale === "de" ? fact : fact.toLocaleLowerCase(i18n.locale);
        return t`Copy ${label}`;
      },
      loading: t`Loading the value`,
    },
    link: {
      external: t`opens in a new tab`,
    },
    markdown: {
      back: (number) => t`Back to reference ${number}`,
      done: t({ message: "Done", context: "a task ticked in a list" }),
      footnote: (number) => t`Footnote ${number}`,
      notDone: t({
        message: "Not done",
        context: "a task not ticked in a list",
      }),
      table: t`Table`,
    },
    sidePanel: {
      close: t`Close`,
      showAll: t`Show all`,
      views: t`Views`,
    },
    stepper: {
      count: (step, total) => t`Step ${step} of ${total}`,
      current: (step, total, label) => t`Step ${step} of ${total}: ${label}`,
      finished: t`All steps done`,
      navBack: t`Back`,
      navNext: t`Next`,
      states: {
        complete: t`done`,
        active: t`current step`,
        pending: t`not started`,
        error: t`failed`,
      },
    },
    switch: {
      error: t`Could not save`,
    },
    toast: {
      close: t`Close`,
      error: t`Could not finish`,
      loading: t`Still working`,
      name: t`Notifications`,
    },
    treeView: {
      clear: t`Clear the filter`,
      empty: t`No matches`,
      filter: t({ message: "Filter", context: "a field that narrows a tree" }),
    },
  };
  return (
    <I18nProvider catalog={catalog} locale={i18n.locale}>
      {children}
    </I18nProvider>
  );
};
