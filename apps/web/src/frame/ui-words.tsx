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
    alertDialog: {
      cancel: t`Cancel`,
    },
    chart: {
      described: (label, summary) => t`${label}. ${summary}`,
      flow: (source, target) => t`${source} → ${target}`,
      flowLabel: ({ source, target, value, share }) =>
        t`${source} to ${target}: ${value}, ${share}`,
      part: (name, value, share) => t`${name}: ${value}, ${share}`,
      partShare: (name, share) => t`${name} · ${share}`,
      point: (name, value) => t`${name}: ${value}`,
      pointAt: (label, points) => [label, ...points].join(", "),
      shareOf: (share, source) => t`${share} of ${source}`,
      step: (name, value) => (name === "" ? value : t`${name} ${value}`),
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
    confirmation: {
      approved: t`Approved`,
      declined: t`Declined`,
      failed: t({
        message: "Failed",
        context: "an answer that did not go through",
      }),
    },
    empty: {
      error: t`This did not load`,
    },
    field: {
      statusError: t`Could not save. Your choice is kept.`,
      statusLoading: t`Saving`,
      statusRetry: t`Try again`,
      statusSuccess: t`Saved`,
    },
    keyValue: {
      copy: (label) => t`Copy ${label}`,
      loading: t`Loading the value`,
    },
    link: {
      external: t`opens in a new tab`,
    },
    questionnaire: {
      error: t`Could not send the answer`,
      next: t({ message: "Next", context: "the next question" }),
      other: t({ message: "Other", context: "an answer of one's own" }),
      previous: t({ message: "Previous", context: "the question before" }),
      progress: (current, total) => t`Question ${current} of ${total}`,
      progressLabel: t`Progress`,
      step: (current, total) => t`${current} of ${total}`,
      recommended: t`Recommended`,
      required: t`Answer this question to go on`,
      skip: t({ message: "Skip", context: "skip a question" }),
      submit: t`Send answer`,
    },
    sheet: {
      close: t`Close`,
    },
    sidePanel: {
      close: t`Close`,
      showAll: t`Show all`,
      views: t({ message: "Views", context: "a side panel's tabs" }),
    },
    tabs: {
      close: (name) => t`Close ${name}`,
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
