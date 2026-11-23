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
    action: {
      agentAsks: t`Does something that needs your yes`,
      agentPresses: (words) => t`Presses "${words}"`,
      error: t`Could not finish`,
      loading: t`Working`,
      success: t`Done`,
    },
    alertDialog: {
      cancel: t({ message: "Cancel", context: "leave a question unanswered" }),
    },
    badge: {
      dot: {
        default: t({ message: "Note", context: "a badge's dot" }),
        success: t({ message: "Done", context: "a badge's dot" }),
        warning: t({ message: "Warning", context: "a badge's dot" }),
        destructive: t({ message: "Error", context: "a badge's dot" }),
        info: t({ message: "Info", context: "a badge's dot" }),
      },
      remove: t({ message: "Remove", context: "take a badge away" }),
      removeNamed: (words) => t`Remove ${words}`,
    },
    codeBlock: {
      collapse: t`Show less`,
      expand: t`Show more`,
      moreLines: (count) =>
        t`${plural(count, { one: "# more line", other: "# more lines" })}`,
      plainText: t({ message: "Text", context: "code's language: plain text" }),
      streaming: t({ message: "Writing", context: "code still being written" }),
    },
    dataTable: {
      actions: t({ message: "Actions", context: "a table's row actions" }),
      actionsFor: (name) => t`Actions for ${name}`,
      cancel: t({ message: "Cancel", context: "leave a question unanswered" }),
      chooseAll: (one) => t`Choose every ${one} shown`,
      chooseColumn: t({
        message: "Choose",
        context: "a table's choice column",
      }),
      clear: t({ message: "Clear", context: "empty a table's filter" }),
      clearSearch: t`Clear search`,
      close: (name) => t`Close ${name}`,
      columnInfo: (header) => t`More about ${header}`,
      columnMenu: (header) => t`Column: ${header}`,
      columns: t({ message: "Columns", context: "a table's columns" }),
      confirm: (action, count, unit) => t`${action} ${count} ${unit}?`,
      confirmDetail: t`This cannot be undone.`,
      done: (action, count, unit) => t`${action}: ${count} ${unit}`,
      error: (many) => t`The ${many} did not load`,
      exportCsv: t`Export CSV`,
      failedDetail: t`Check the connection, then try again.`,
      filterAtLeast: t({ message: "is at least", context: "a table filter" }),
      filterAtMost: t({ message: "is at most", context: "a table filter" }),
      filterContains: t({ message: "contains", context: "a table filter" }),
      filterField: t({ message: "Field", context: "a table filter" }),
      filterIs: t({ message: "is", context: "a table filter" }),
      filterIsNot: t({ message: "is not", context: "a table filter" }),
      filterLabel: (label) => t`Filter ${label}`,
      filterLacks: t({
        message: "does not contain",
        context: "a table filter",
      }),
      filterName: t`Filter condition`,
      filterOperator: t({ message: "Operator", context: "a table filter" }),
      filterSegments: {
        field: t`Filter field`,
        operator: t`Filter operator`,
        value: t`Filter value`,
      },
      filterValue: t({ message: "Value", context: "a table filter" }),
      groupAttention: t({
        message: "needs attention",
        context: "a table's group of rows",
      }),
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
      rowPending: t({ message: "pending", context: "a table row's state" }),
      rowRemoved: t({ message: "removed", context: "a table row's state" }),
      search: (many) => t`Search ${many}`,
      searchLabel: (label) => t`Search ${label}`,
      select: (name) => t`Choose ${name}`,
      selected: (count, total) => t`${count} of ${total} chosen`,
      sortDown: t`Sort high to low`,
      sortNext: t`Sort by this next`,
      sortUp: t`Sort low to high`,
      tryAgain: t`Try again`,
      undo: t({ message: "Undo", context: "take a table's change back" }),
      unpin: t`Unpin`,
      view: t({ message: "View", context: "a table's view settings" }),
      width: (header) => t`Width of ${header}`,
      withChosen: (many) => t`With the chosen ${many}`,
      unit: {
        one: t({ message: "row", context: "a table's row, one" }),
        other: t({ message: "rows", context: "a table's rows, many" }),
      },
    },
    dialog: {
      close: t({ message: "Close", context: "close a dialog or panel" }),
    },
    field: {
      statusError: t`Could not save. Your choice is kept.`,
      statusLoading: t({ message: "Saving", context: "a setting saving" }),
      statusRetry: t`Try again`,
      statusSuccess: t({ message: "Saved", context: "a setting saved" }),
    },
    input: {
      hidePassword: t`Hide password`,
      replace: t({ message: "Replace", context: "replace a saved secret" }),
      showPassword: t`Show password`,
    },
    sheet: {
      close: t({ message: "Close", context: "close a dialog or panel" }),
    },
    sidePanel: {
      close: t({ message: "Close", context: "close a dialog or panel" }),
      showAll: t`Show all`,
      views: t({ message: "Views", context: "a side panel's views" }),
    },
    trace: {
      states: {
        running: t({ message: "Working", context: "a step's state" }),
        error: t({ message: "Failed", context: "a step's state" }),
        pending: t({ message: "Waiting", context: "a step's state" }),
      },
    },
  };
  return (
    <I18nProvider catalog={catalog} locale={i18n.locale}>
      {children}
    </I18nProvider>
  );
};
