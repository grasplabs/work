import { I18nProvider } from "@grasp-os/ui/lib/i18n";
import type { I18nCatalog } from "@grasp-os/ui/lib/i18n";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

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
    alert: {
      close: t`Dismiss`,
    },
    alertDialog: {
      cancel: t`Cancel`,
    },
    attachment: {
      remove: (name) => t`Remove ${name}`,
    },
    chainOfThought: {
      name: t`Steps`,
    },
    codeBlock: {
      collapse: t`Show less`,
      expand: t`Show more`,
      moreLines: (count) =>
        t`${plural(count, { one: "# more line", other: "# more lines" })}`,
      plainText: t({ message: "Text", context: "a code block's language" }),
      streaming: t({
        message: "Writing",
        context: "a code block being written",
      }),
    },
    command: {
      dialogPlaceholder: t`Type a command or search`,
      dialogTrigger: t({ message: "Search", context: "open the search" }),
      empty: t`No results`,
      error: t({ message: "Failed", context: "a search that failed" }),
      expand: (label) => t`More for ${label}`,
      loading: t`Searching`,
      moreHint: t`Right arrow for more`,
      placeholder: t({ message: "Search", context: "a search field" }),
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
    holdButton: {
      ask: (words) => t`${words}?`,
      cancel: t`Cancel`,
      confirm: t`Confirm`,
      holdTo: (words) => t`Press and hold: ${words}`,
    },
    inlineEdit: {
      edit: t({ message: "Edit", context: "edit a value in place" }),
      error: t`Could not save`,
      saved: (value) => t`Changed to ${value}`,
    },
    keyValue: {
      copy: (label) => t`Copy ${label}`,
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
    modelSelector: {
      empty: t`No models found`,
      search: t`Search models`,
      trigger: t({ message: "Model", context: "the model an answer uses" }),
      triggerWith: (trigger, model) => t`${trigger}: ${model}`,
      makers: t`Makers`,
      favorites: t`Favourites`,
      noFavorites: t`No favourites yet`,
      effort: t({ message: "Thinking", context: "how hard a model thinks" }),
      addFavorite: (model) => t`Add ${model} to favourites`,
      removeFavorite: (model) => t`Remove ${model} from favourites`,
      added: (model) => t`${model} added to favourites`,
      removed: (model) => t`${model} removed from favourites`,
      chosen: (model) => t`${model} chosen`,
      favoriteKeys: t`At the end of the search, the arrow toward the line's end stars or unstars the highlighted model`,
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
      submit: t({ message: "Send", context: "send a message" }),
      succeeded: t({ message: "Done", context: "a message sent" }),
      // Closing a spoken conversation gives the text back.
      voice: {
        close: t`Type instead`,
        label: t`Voice conversation`,
        listening: t`Listening`,
        speaking: t({ message: "Speaking", context: "the other voice's turn" }),
      },
    },
    questionnaire: {
      error: t`Could not send the answer`,
      next: t({ message: "Next", context: "the next question" }),
      other: t`In my own words`,
      previous: t({ message: "Previous", context: "the question before" }),
      progress: (current, total) => t`Question ${current} of ${total}`,
      progressLabel: t`Progress`,
      step: (current, total) => t`${current} of ${total}`,
      recommended: t`Recommended`,
      required: t`Answer this question to go on`,
      skip: t({ message: "Skip", context: "skip a question" }),
      submit: t`Send answer`,
    },
    reasoning: {
      done: t({ message: "Thought", context: "the model thought first" }),
      thinking: t`Thinking`,
      thought: (seconds) =>
        t`${plural(seconds, { one: "Thought for # second", other: "Thought for # seconds" })}`,
    },
    sheet: {
      close: t`Close`,
    },
    sources: {
      count: (count) =>
        count === 0
          ? t`No sources`
          : t`${plural(count, { one: "# source", other: "# sources" })}`,
      gone: t`Could not be opened`,
      heading: t`Sources`,
      locked: t`You cannot open this`,
      newTab: t`(opens in a new tab)`,
    },
    tool: {
      error: t({ message: "Error", context: "what a tool call failed with" }),
      input: t({ message: "Input", context: "what went into a tool call" }),
      output: t({ message: "Output", context: "what a tool call gave back" }),
      states: {
        "input-streaming": t({
          message: "Pending",
          context: "a tool call's state",
        }),
        "input-available": t({
          message: "Running",
          context: "a tool call's state",
        }),
        "approval-requested": t({
          message: "Awaiting approval",
          context: "a tool call's state",
        }),
        "approval-responded": t({
          message: "Responded",
          context: "a tool call's state",
        }),
        "output-available": t({
          message: "Completed",
          context: "a tool call's state",
        }),
        "output-error": t({
          message: "Error",
          context: "a tool call's state",
        }),
        "output-denied": t({
          message: "Denied",
          context: "a tool call's state",
        }),
      },
    },
    trace: {
      states: {
        running: t({ message: "Working", context: "a step's state" }),
        error: t({ message: "Failed", context: "a step's state" }),
        pending: t({ message: "Waiting", context: "a step's state" }),
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
    input: {
      hidePassword: t`Hide password`,
      replace: t`Replace`,
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
  };
  return (
    <I18nProvider catalog={catalog} locale={i18n.locale}>
      {children}
    </I18nProvider>
  );
};
