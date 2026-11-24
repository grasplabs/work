import { I18nProvider } from "@grasp-os/ui/lib/i18n";
import type { I18nCatalog } from "@grasp-os/ui/lib/i18n";
import { plural, selectOrdinal } from "@lingui/core/macro";
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
    input: {
      hidePassword: t`Hide password`,
      replace: t({ message: "Replace", context: "a secret key, typed again" }),
      showPassword: t`Show password`,
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
    // The parts the Apps pages use (apps/), from here on.
    alert: { close: t`Dismiss` },
    avatar: {
      groupCount: (count) => t`+${count}`,
      // The names shown and how many more, joined as the language joins a list.
      groupName: (shown, rest) =>
        formatList(
          rest > 0
            ? [
                ...shown,
                t`${plural(rest, { one: "# other", other: "# others" })}`,
              ]
            : shown
        ),
    },
    badge: {
      dot: {
        default: t({ message: "Note", context: "a badge's dot" }),
        success: t({ message: "Done", context: "a badge's dot" }),
        warning: t({ message: "Warning", context: "a badge's dot" }),
        destructive: t({ message: "Error", context: "a badge's dot" }),
        info: t({ message: "Info", context: "a badge's dot" }),
      },
      remove: t({
        message: "Remove",
        context: "a badge that can be taken off",
      }),
      removeNamed: (words) => t`Remove ${words}`,
    },
    codeBlock: {
      collapse: t`Show less`,
      expand: t`Show more`,
      moreLines: (count) =>
        t`${plural(count, { one: "# more line", other: "# more lines" })}`,
      plainText: t({ message: "Text", context: "code with no language" }),
      streaming: t`Writing`,
    },
    combobox: {
      empty: t`No results`,
      notChoice: (value) => t`${value} is not one of the choices`,
      trigger: t`Show the choices`,
    },
    command: {
      dialogPlaceholder: t`Type a command or search`,
      dialogTrigger: t({
        message: "Search",
        context: "a command list's field",
      }),
      empty: t`No results`,
      error: t({ message: "Failed", context: "a list row's action" }),
      expand: (label) => t`More for ${label}`,
      loading: t({ message: "Searching", context: "a list fetching results" }),
      moreHint: t`Right arrow for more`,
      placeholder: t({ message: "Search", context: "a command list's field" }),
    },
    // `one` and `many` are the table's own nouns ("record", "records"),
    // which the page gives in its language.
    dataTable: {
      actions: t`Actions`,
      actionsFor: (name) => t`Actions for ${name}`,
      cancel: t`Cancel`,
      chooseAll: (one) => t`Choose every ${one} shown`,
      chooseColumn: t({
        message: "Choose",
        context: "a table's checkbox column",
      }),
      clear: t({ message: "Clear", context: "rows chosen in a table" }),
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
      filterAtLeast: t({
        message: "is at least",
        context: "a filter's operator",
      }),
      filterAtMost: t({
        message: "is at most",
        context: "a filter's operator",
      }),
      filterContains: t({
        message: "contains",
        context: "a filter's operator",
      }),
      filterField: t({ message: "Field", context: "what a filter looks at" }),
      filterIs: t({ message: "is", context: "a filter's operator" }),
      filterIsNot: t({ message: "is not", context: "a filter's operator" }),
      filterLabel: (label) => {
        const name = label.toLowerCase();
        return t`Filter ${name}`;
      },
      filterLacks: t({
        message: "does not contain",
        context: "a filter's operator",
      }),
      filterName: t`Filter condition`,
      filterOperator: t({ message: "Operator", context: "a filter's part" }),
      filterSegments: {
        field: t`Filter field`,
        operator: t`Filter operator`,
        value: t`Filter value`,
      },
      filterValue: t({ message: "Value", context: "a filter's part" }),
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
      pages: (label) => {
        const name = label.toLowerCase();
        return t`Pages of ${name}`;
      },
      pinEnd: t`Pin to the end`,
      pinStart: t`Pin to the start`,
      rowPending: t({
        message: "pending",
        context: "a table row not yet in effect",
      }),
      rowRemoved: t({
        message: "removed",
        context: "a table row of something taken away",
      }),
      search: (many) => t`Search ${many}`,
      searchLabel: (label) => {
        const name = label.toLowerCase();
        return t`Search ${name}`;
      },
      select: (name) => t`Choose ${name}`,
      selected: (count, total) => t`${count} of ${total} chosen`,
      sortDown: t`Sort high to low`,
      sortNext: t`Sort by this next`,
      sortUp: t`Sort low to high`,
      tryAgain: t`Try again`,
      undo: t`Undo`,
      unpin: t`Unpin`,
      view: t({ message: "View", context: "a table's view menu" }),
      width: (header) => t`Width of ${header}`,
      withChosen: (many) => t`With the chosen ${many}`,
      unit: {
        one: t({ message: "row", context: "a table's rows, counted" }),
        other: t({ message: "rows", context: "a table's rows, counted" }),
      },
    },
    dropdownMenu: { expand: t`More actions` },
    empty: { error: t`This did not load` },
    field: {
      statusError: t`Could not save. Your choice is kept.`,
      statusLoading: t`Saving`,
      statusRetry: t`Try again`,
      statusSuccess: t`Saved`,
    },
    keyValue: {
      copy: (label) => {
        const what = label.toLocaleLowerCase();
        return t`Copy ${what}`;
      },
      loading: t`Loading the value`,
    },
    table: {
      sortIndex: (place) =>
        t`${selectOrdinal(place, { one: "sorted #st", two: "sorted #nd", few: "sorted #rd", other: "sorted #th" })}`,
    },
    tabs: { close: (name) => t`Close ${name}` },
    toast: {
      close: t`Close`,
      error: t`Could not finish`,
      loading: t`Still working`,
      name: t`Notifications`,
    },
    treeView: {
      clear: t`Clear the filter`,
      empty: t`No matches`,
      filter: t`Filter`,
    },
  };
  return (
    <I18nProvider catalog={catalog} locale={i18n.locale}>
      {children}
    </I18nProvider>
  );
};
