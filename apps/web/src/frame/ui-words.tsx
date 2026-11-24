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
    alertDialog: { cancel: t`Cancel` },
    dialog: { close: t`Close` },
    drawer: { handle: t`Resize` },
    dropdownMenu: { expand: t`More actions` },
    empty: { error: t`This did not load` },
    field: {
      statusError: t`Could not save. Your choice is kept.`,
      statusLoading: t`Saving`,
      statusRetry: t`Try again`,
      statusSuccess: t`Saved`,
    },
    fileUpload: {
      added: (count) =>
        plural(count, { one: "# file added", other: "# files added" }),
      doneLine: (size) => t`${size}, uploaded`,
      drop: t`Drop files here, or`,
      error: t`Could not upload`,
      files: t`Files`,
      limits: (types, maxSize) => {
        const kinds = formatList(types, "disjunction");
        if (maxSize === undefined) {
          return kinds;
        }
        return kinds === ""
          ? t`Up to ${maxSize}`
          : t`${kinds}, up to ${maxSize}`;
      },
      notSent: (name) => t`Could not upload ${name}.`,
      refused: (name, reason) => {
        if (reason === "file-too-large") {
          return t`${name} is too large.`;
        }
        if (reason === "file-too-small") {
          return t`${name} is empty.`;
        }
        if (reason === "too-many-files") {
          return t`${name} is one file too many.`;
        }
        return t`${name} is not a kind of file this takes.`;
      },
      remove: (name) => t`Remove ${name}`,
      removed: (names) => {
        const [only] = names;
        const removed = names.length;
        return removed === 1 && only !== undefined
          ? t`${only} removed`
          : plural(removed, {
              one: "# file removed",
              other: "# files removed",
            });
      },
      retry: t`Try again`,
      select: t`Choose files`,
      sent: (name) => t`${name} uploaded.`,
      uploading: (percent) => t`Uploading, ${percent}%`,
      uploadingName: (name) => t`Uploading ${name}`,
    },
    keyValue: {
      copy: (label) => t`Copy ${label}`,
      loading: t`Loading the value`,
    },
    questionnaire: {
      error: t`Could not send the answer`,
      next: t`Next`,
      other: t`Other`,
      previous: t`Previous`,
      progress: (current, total) => t`Question ${current} of ${total}`,
      progressLabel: t`Progress`,
      step: (current, total) => t`${current} of ${total}`,
      recommended: t`Recommended`,
      required: t`Answer this question to go on`,
      skip: t`Skip`,
      submit: t`Send answer`,
    },
    stepper: {
      count: (step, total) => t`Step ${step} of ${total}`,
      current: (step, total, label) => t`Step ${step} of ${total}: ${label}`,
      finished: t`All steps done`,
      navBack: t`Back`,
      navNext: t`Next`,
      states: {
        complete: t({ message: "done", context: "a step's state" }),
        active: t`current step`,
        pending: t`not started`,
        error: t({ message: "failed", context: "a step's state" }),
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
