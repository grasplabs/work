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
      cancel: t`Cancel`,
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
