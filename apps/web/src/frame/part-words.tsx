import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

import { alertWords } from "../grasp/alert/words.ts";
import { appShellPanelWords } from "../grasp/app-shell/words.ts";
import { badgeWords } from "../grasp/badge/words.ts";
import { buttonWords } from "../grasp/button/words.ts";
import { codeBlockWords } from "../grasp/code-block/words.ts";
import { copyFieldWords } from "../grasp/copy-field/words.ts";
import { dialogWords } from "../grasp/dialog/words.ts";
import { paginationWords } from "../grasp/pagination/words.ts";
import { settingRowWords } from "../grasp/setting-row/words.ts";
import { sidebarWords } from "../grasp/sidebar/words.ts";
import { tagWords } from "../grasp/tag/words.ts";
import { toasterWords } from "../grasp/toast/words.ts";
import { renameWords } from "../grasp/words/rename.ts";
import { GraspWords } from "../grasp/words/words.tsx";
import type { GraspWordsCatalog } from "../grasp/words/words.tsx";

// The words Grasp UI's parts say themselves (a dialog's Close, the chat
// panel's Full screen, a pagination's range), in the page's language,
// through the parts' one provider (GraspWords), around every page.
// English is each part's own: the library's words, as it wrote them. Every
// other language is Lingui's, translated as the rest of the page is, so a
// part never speaks English on a Dutch page. Work's own sentences stay
// Lingui's own, as ever.

/** Every installed part's words in English: the library's own. */
export const englishPartWords: GraspWordsCatalog = {
  "app-shell-panel": appShellPanelWords,
  alert: alertWords,
  badge: badgeWords,
  button: buttonWords,
  codeBlock: codeBlockWords,
  copyField: copyFieldWords,
  dialog: dialogWords,
  pagination: paginationWords,
  rename: renameWords,
  settingRow: settingRowWords,
  sidebar: sidebarWords,
  tag: tagWords,
  toaster: toasterWords,
};

/** Every installed part's words in the page's language, from its Lingui catalog. */
export const usePartWords = (): GraspWordsCatalog => {
  const { t } = useLingui();
  return {
    "app-shell-panel": {
      move: t`Move the panel`,
      moveHint: t`Arrow keys move it, Shift for a longer step, End docks it beside the page, Escape goes back to the page`,
      float: t`Float over the page`,
      dock: t`Dock beside the page`,
      page: t`Open as a page`,
      expand: t`Full screen`,
      collapse: t`Leave full screen`,
      width: t`Resize the panel's width`,
      height: t`Resize the panel's height`,
    },
    alert: { dismiss: t`Dismiss` },
    badge: {
      dot: {
        neutral: t({ message: "Note", context: "a badge's dot" }),
        success: t({ message: "Done", context: "a badge's dot" }),
        attention: t({ message: "Warning", context: "a badge's dot" }),
        danger: t({ message: "Error", context: "a badge's dot" }),
        info: t({ message: "Info", context: "a badge's dot" }),
      },
    },
    button: {
      working: t`Working`,
      // The button's own words as they stand: a language may not start
      // them lower case (German nouns).
      holdTo: (words) => t`Hold to confirm: ${words}`,
      ask: (words) => t`${words}?`,
      confirm: t`Confirm`,
      cancel: t`Cancel`,
      agentAsks: t`Does something that needs your yes`,
      agentPresses: (words) => t`Presses "${words}"`,
      agentStillSays: (shown) =>
        t`It still says "${shown}". Press it again in a moment.`,
    },
    codeBlock: {
      copy: t`Copy code`,
      copied: t`Copied`,
      copyFailed: t`Could not copy`,
      writing: t`Writing`,
      more: t`Show more`,
      less: t`Show less`,
    },
    copyField: { copied: t`Copied`, failed: t`Could not copy` },
    dialog: { close: t`Close` },
    pagination: {
      name: t`Pagination`,
      previous: t`Previous page`,
      next: t`Next page`,
      loading: t`Loading the page`,
      unit: {
        one: t({ message: "item", context: "pagination, one" }),
        other: t({ message: "items", context: "pagination, many" }),
      },
      range: (first, last, total, unit) =>
        t`Showing ${first} – ${last} of ${total} ${unit}`,
      page: (current, count) => t`Page ${current} of ${count}`,
      none: (unit) => t`No ${unit}`,
    },
    rename: {
      rename: t`Rename`,
      field: t({ message: "Name", context: "a renamed thing's new name" }),
      save: t`Save`,
      cancel: t`Cancel`,
      hint: t`Double-click or press F2 to rename`,
    },
    settingRow: {
      info: t`More about this setting`,
      saving: t`Saving`,
      saved: t`Saved`,
      failed: t`Could not save. Your choice is kept.`,
      retry: t`Try again`,
    },
    sidebar: {
      name: t`Sidebar`,
      main: t({ message: "Main", context: "the sidebar's main list" }),
      search: t`Search`,
      fold: t`Show or hide the sidebar`,
      views: t`Views`,
      back: t`Back`,
      appearance: t`Appearance`,
      actions: (label) => t`More for ${label}`,
      renamed: (name) => t`Renamed to ${name}`,
      working: t`Working`,
    },
    tag: {
      remove: t`Remove`,
      removeNamed: (words) => t`Remove ${words}`,
    },
    toaster: {
      name: t`Notifications`,
      failed: t`Could not finish`,
      pending: t`Still working`,
      close: t`Close`,
    },
  };
};

/** The parts' words around everything in it, in the page's language. */
export const PartWords = ({ children }: { children: ReactNode }) => {
  const { i18n } = useLingui();
  const translated = usePartWords();
  return (
    <GraspWords
      locale={i18n.locale}
      words={i18n.locale === "en" ? englishPartWords : translated}
    >
      {children}
    </GraspWords>
  );
};
