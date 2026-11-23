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
      error: t`Failed`,
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
    empty: {
      error: t`This did not load`,
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
      assistant: t`Assistant`,
      done: t`Answer ready`,
      error: t`Could not answer`,
      retry: t`Try again`,
      stopped: t({ message: "Stopped", context: "an answer stopped part way" }),
      streaming: t({ message: "Writing", context: "an answer being written" }),
      user: t({ message: "You", context: "who wrote a message" }),
    },
    messageScroller: {
      arrived: (count) =>
        t`${plural(count, { one: "# new message", other: "# new messages" })}`,
      jumpToNew: (jumpLabel) => t`${jumpLabel}, new messages`,
      label: t`Messages`,
      loading: t`Loading the conversation`,
      scrollToEnd: t`Jump to latest`,
      scrollToStart: t`Jump to start`,
    },
    reasoning: {
      done: t({ message: "Thought", context: "the model thought first" }),
      thinking: t`Thinking`,
      thought: (seconds) =>
        t`${plural(seconds, { one: "Thought for # second", other: "Thought for # seconds" })}`,
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
  };
  return (
    <I18nProvider catalog={catalog} locale={i18n.locale}>
      {children}
    </I18nProvider>
  );
};
