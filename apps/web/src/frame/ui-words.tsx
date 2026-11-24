import { I18nProvider } from "@grasp-os/ui/lib/i18n";
import type { I18nCatalog } from "@grasp-os/ui/lib/i18n";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

import { formatList } from "../format.ts";

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
    // Settings' parts (routes/_shell.settings*.tsx, settings/).
    alert: { close: t`Dismiss` },
    alertDialog: { cancel: t`Cancel` },
    avatar: {
      groupCount: (count) => `+${String(count)}`,
      groupName: (shown, rest) => {
        const listed = formatList(shown);
        return rest === 0
          ? listed
          : t`${listed} and ${plural(rest, { one: "# other", other: "# others" })}`;
      },
    },
    codeBlock: {
      collapse: t`Show less`,
      expand: t`Show more`,
      moreLines: (count) =>
        t`${plural(count, { one: "# more line", other: "# more lines" })}`,
      plainText: t`Text`,
      streaming: t`Writing`,
    },
    combobox: {
      empty: t`No results`,
      notChoice: (value) => t`${value} is not one of the choices`,
      trigger: t`Show the choices`,
    },
    dataTable: {
      actions: t`Actions`,
      actionsFor: (name) => t`Actions for ${name}`,
      cancel: t`Cancel`,
      chooseAll: (one) => t`Choose every ${one} shown`,
      chooseColumn: t`Choose`,
      clear: t`Clear`,
      clearSearch: t`Clear search`,
      close: (name) => t`Close ${name}`,
      columnInfo: (header) => t`More about ${header}`,
      columnMenu: (header) => t`Column: ${header}`,
      columns: t`Columns`,
      confirm: (action, count, unit) => t`${action} ${count} ${unit}?`,
      confirmDetail: t`This cannot be undone.`,
      done: (action, count, unit) => t`${action}: ${count} ${unit}`,
      error: (many) => t`The ${many} did not load`,
      exportCsv: t`Export CSV`,
      failedDetail: t`Check the connection, then try again.`,
      filterAtLeast: t`is at least`,
      filterAtMost: t`is at most`,
      filterContains: t`contains`,
      filterField: t`Field`,
      filterIs: t`is`,
      filterIsNot: t`is not`,
      filterLabel: (label) => t`Filter ${label}`,
      filterLacks: t`does not contain`,
      filterName: t`Filter condition`,
      filterOperator: t`Operator`,
      filterSegments: {
        field: t`Filter field`,
        operator: t`Filter operator`,
        value: t`Filter value`,
      },
      filterValue: t`Value`,
      groupAttention: t`needs attention`,
      hide: t`Hide column`,
      loading: (many) => t`Loading ${many}`,
      loadingMore: (many) => t`Loading more ${many}`,
      moveEarlier: t`Move earlier`,
      moveLater: t`Move later`,
      noDate: t`No date`,
      noMatch: (many, query) => t`No ${many} match “${query}”.`,
      noneMeet: (many) => t`No ${many} meet the filter.`,
      noneYet: (many) => t`No ${many} yet.`,
      open: (name) => t`Open ${name}`,
      pages: (label) => t`Pages of ${label}`,
      pinEnd: t`Pin to the end`,
      pinStart: t`Pin to the start`,
      rowPending: t`pending`,
      rowRemoved: t`removed`,
      search: (many) => t`Search ${many}`,
      searchLabel: (label) => t`Search ${label}`,
      select: (name) => t`Choose ${name}`,
      selected: (count, total) => t`${count} of ${total} chosen`,
      sortDown: t`Sort high to low`,
      sortNext: t`Sort by this next`,
      sortUp: t`Sort low to high`,
      tryAgain: t`Try again`,
      undo: t`Undo`,
      unpin: t`Unpin`,
      view: t`View`,
      width: (header) => t`Width of ${header}`,
      withChosen: (many) => t`With the chosen ${many}`,
      unit: { one: t`row`, other: t`rows` },
    },
    dialog: { close: t`Close` },
    dropdownMenu: { expand: t`More actions` },
    field: {
      statusError: t`Could not save. Your choice is kept.`,
      statusLoading: t`Saving`,
      statusRetry: t`Try again`,
      statusSuccess: t`Saved`,
    },
    imageUpload: {
      add: t`Add a picture`,
      change: t`Change picture`,
      error: t`Could not save`,
      how: t`Click or drop a picture.`,
      refused: (name, reason) => {
        if (reason === "file-too-large") {
          return t`${name} is too large.`;
        }
        return reason === "file-too-small"
          ? t`${name} is empty.`
          : t`${name} is not a kind of picture this takes.`;
      },
      refusedInRow: (reason) => {
        if (reason === "file-too-large") {
          return t`Too large.`;
        }
        return reason === "file-too-small"
          ? t`That file is empty.`
          : t`Not a kind of picture this takes.`;
      },
      remove: t`Remove picture`,
      retry: t`Try again`,
      retryTip: t`Could not save. Try again?`,
      saved: t`Saved`,
      saving: t`Saving`,
    },
    input: {
      hidePassword: t`Hide password`,
      replace: t`Replace`,
      showPassword: t`Show password`,
    },
    pagination: {
      loading: t`Loading the page`,
      name: t`Pagination`,
      next: t`Next page`,
      none: (unit) => t`No ${unit}`,
      page: (current, count) => t`Page ${current} of ${count}`,
      previous: t`Previous page`,
      range: (first, last, total, unit) =>
        t`Showing ${first} – ${last} of ${total} ${unit}`,
      unit: { one: t`item`, other: t`items` },
    },
    sheet: { close: t`Close` },
    switch: { error: t`Could not save` },
    tagsInput: {
      duplicate: (word) => t`“${word}” is already added.`,
      empty: t`Press Enter to add it.`,
      full: (most) => t`Up to ${most}.`,
      invalid: t`not valid`,
    },
    themeToggle: {
      // No line under a mode's tile: each is drawn as what it is, and its
      // name says the rest.
      dark: { name: t`Dark`, line: "" },
      icon: (label, current, next) =>
        t`${label}, ${current}. Switch to ${next}`,
      label: t`Theme`,
      light: { name: t`Light`, line: "" },
      // Said to an agent that asks for a mode or theme there is none of: English, as the agent reads it.
      noMode: (mode, modes) =>
        `No mode "${mode}" in Theme. Its modes: ${modes.join(", ")}.`,
      noTheme: (theme, known) =>
        `No theme "${theme}" in Theme. Its themes: ${known.join(", ")}.`,
      system: { name: t`System`, line: "" },
      themes: t`Colours`,
    },
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
    action: {
      agentAsks: t`Does something that needs your yes`,
      agentPresses: (words) => t`Presses "${words}"`,
      error: t`Could not finish`,
      loading: t`Working`,
      success: t`Done`,
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
  };
  return (
    <I18nProvider catalog={catalog} locale={i18n.locale}>
      {children}
    </I18nProvider>
  );
};
