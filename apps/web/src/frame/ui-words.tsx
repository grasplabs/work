import { I18nProvider } from "@grasp-os/ui/lib/i18n";
import type { I18nCatalog } from "@grasp-os/ui/lib/i18n";
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
    action: {
      agentAsks: t`Does something that needs your yes`,
      agentPresses: (words) => t`Presses "${words}"`,
      error: t`Could not finish`,
      loading: t`Working`,
      success: t`Done`,
    },
    alert: { close: t({ message: "Dismiss", context: "close a notice" }) },
    alertDialog: { cancel: t`Cancel` },
    badge: {
      dot: {
        default: t({ message: "Note", context: "how serious a badge is" }),
        success: t({ message: "Done", context: "how serious a badge is" }),
        warning: t({ message: "Warning", context: "how serious a badge is" }),
        destructive: t({ message: "Error", context: "how serious a badge is" }),
        info: t({ message: "Info", context: "how serious a badge is" }),
      },
      remove: t`Remove`,
      removeNamed: (words) => t`Remove ${words}`,
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
    dialog: { close: t`Close` },
    dropdownMenu: { expand: t`More actions` },
    empty: { error: t`This did not load` },
    field: {
      statusError: t`Could not save. Your choice is kept.`,
      statusLoading: t`Saving`,
      statusRetry: t`Try again`,
      statusSuccess: t`Saved`,
    },
    input: {
      hidePassword: t`Hide password`,
      replace: t({ message: "Replace", context: "a saved key" }),
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
    link: { external: t`opens in a new tab` },
    sheet: { close: t`Close` },
    sidePanel: {
      close: t`Close`,
      showAll: t`Show all`,
      views: t({ message: "Views", context: "a panel's tabs" }),
    },
    stepper: {
      count: (step, total) => t`Step ${step} of ${total}`,
      current: (step, total, label) => t`Step ${step} of ${total}: ${label}`,
      finished: t`All steps done`,
      navBack: t`Back`,
      navNext: t`Next`,
      states: {
        complete: t({ message: "done", context: "a step's status" }),
        active: t({ message: "current step", context: "a step's status" }),
        pending: t({ message: "not started", context: "a step's status" }),
        error: t({ message: "failed", context: "a step's status" }),
      },
    },
    switch: { error: t`Could not save` },
  };
  return (
    <I18nProvider catalog={catalog} locale={i18n.locale}>
      {children}
    </I18nProvider>
  );
};
