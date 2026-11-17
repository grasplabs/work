import { plural, selectOrdinal } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

import { useApprovalWords } from "../chat/approval-words.ts";
import { formatList } from "../format.ts";
import { agentActivityWords } from "../grasp/agent-activity/words.ts";
import { alertWords } from "../grasp/alert/words.ts";
import { appShellPanelWords, appShellWords } from "../grasp/app-shell/words.ts";
import { approvalRequestWords } from "../grasp/approval-request/words.ts";
import { avatarGroupWords } from "../grasp/avatar/words.ts";
import { badgeWords } from "../grasp/badge/words.ts";
import { buttonWords } from "../grasp/button/words.ts";
import { calendarWords } from "../grasp/calendar/words.ts";
import { chatMessageWords } from "../grasp/chat-message/words.ts";
import { codeBlockWords } from "../grasp/code-block/words.ts";
import { comboboxWords } from "../grasp/combobox/words.ts";
import { copyFieldWords } from "../grasp/copy-field/words.ts";
import {
  dataTableWords,
  englishFilterWords,
} from "../grasp/data-table/words.ts";
import { datePickerWords } from "../grasp/date-picker/words.ts";
import { dateRangePickerWords } from "../grasp/date-range-picker/words.ts";
import { dialogWords } from "../grasp/dialog/words.ts";
import { emptyWords } from "../grasp/empty/words.ts";
import { fileUploadWords, imageWellWords } from "../grasp/file-upload/words.ts";
import { languageSwitchWords } from "../grasp/language-switch/words.ts";
import { markdownWords } from "../grasp/markdown/words.ts";
import { paginationWords } from "../grasp/pagination/words.ts";
import { settingRowWords } from "../grasp/setting-row/words.ts";
import { sheetWords } from "../grasp/sheet/words.ts";
import { sidebarWords } from "../grasp/sidebar/words.ts";
import { sourcesWords } from "../grasp/sources/words.ts";
import { tagInputWords } from "../grasp/tag-input/words.ts";
import { tagWords } from "../grasp/tag/words.ts";
import { dayWritten } from "../grasp/thread/rows.ts";
import { threadWords } from "../grasp/thread/words.ts";
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
  agentActivity: agentActivityWords,
  alert: alertWords,
  appShell: appShellWords,
  approvalRequest: approvalRequestWords,
  avatarGroup: avatarGroupWords,
  badge: badgeWords,
  calendar: calendarWords,
  combobox: comboboxWords,
  datePicker: datePickerWords,
  dateRangePicker: dateRangePickerWords,
  languageSwitch: languageSwitchWords,
  tagInput: tagInputWords,
  button: buttonWords,
  chatMessage: chatMessageWords,
  codeBlock: codeBlockWords,
  copyField: copyFieldWords,
  dataTable: dataTableWords,
  dataTableFilters: englishFilterWords,
  dialog: dialogWords,
  empty: emptyWords,
  fileUpload: fileUploadWords,
  imageWell: imageWellWords,
  markdown: markdownWords,
  pagination: paginationWords,
  rename: renameWords,
  settingRow: settingRowWords,
  sheet: sheetWords,
  sidebar: sidebarWords,
  sources: sourcesWords,
  tag: tagWords,
  thread: threadWords,
  toaster: toasterWords,
};

/** Every installed part's words in the page's language, from its Lingui catalog. */
export const usePartWords = (): GraspWordsCatalog => {
  const { t, i18n } = useLingui();
  const approval = useApprovalWords();
  // Why a file stays out, from what the part says (its reason's code).
  const refusedFile = (name: string, reason: string, picture: boolean) => {
    if (reason === "file-type") {
      return picture
        ? t`${name} is not a kind of picture this takes.`
        : t`${name} is not a kind of file this takes.`;
    }
    if (reason === "file-too-large") {
      return t`${name} is too large.`;
    }
    if (reason === "file-too-small") {
      return t`${name} is empty.`;
    }
    if (reason === "too-many-files") {
      return t`${name} is one file too many.`;
    }
    return t`${name}: ${reason}`;
  };
  return {
    approvalRequest: {
      ...approval,
      approve: t({ message: "Approve", context: "an agent's request" }),
      changesPlaceholder: t`Say what should change`,
      viewer: t({ message: "You", context: "who answered an agent's request" }),
    },
    // `one` and `many` are the table's own nouns ("report", "reports"),
    // which the page gives in its language.
    dataTable: {
      search: (many) => t`Search ${many}`,
      searchLabel: (label) => {
        const name = label.toLowerCase();
        return t`Search ${name}`;
      },
      clearSearch: t`Clear search`,
      filterLabel: (label) => {
        const name = label.toLowerCase();
        return t`Filter ${name}`;
      },
      chosen: (count, total) => t`${count} of ${total} chosen`,
      chooseAll: (one) => t`Choose every ${one} shown`,
      choose: (name) => t`Choose ${name}`,
      chooseColumn: t({
        message: "Choose",
        context: "a table's checkbox column",
      }),
      withChosen: (many) => t`With the chosen ${many}`,
      clear: t({ message: "Clear", context: "rows chosen in a table" }),
      done: (action, count, unit) => t`${action}: ${count} ${unit}`,
      undo: t`Undo`,
      confirm: (action, count, unit) => t`${action} ${count} ${unit}?`,
      confirmDetail: t`This cannot be undone.`,
      cancel: t`Cancel`,
      view: t({ message: "View", context: "a table's view menu" }),
      columns: t`Columns`,
      columnMenu: (header) => t`Column: ${header}`,
      sortUp: t`Sort low to high`,
      sortDown: t`Sort high to low`,
      sortNext: t`Sort by this next`,
      pinStart: t`Pin to the start`,
      pinEnd: t`Pin to the end`,
      unpin: t`Unpin`,
      moveEarlier: t`Move earlier`,
      moveLater: t`Move later`,
      hide: t`Hide column`,
      width: (header) => t`Width of ${header}`,
      sortedPlace: (place) =>
        t`${selectOrdinal(place, { one: ", sorted #st", two: ", sorted #nd", few: ", sorted #rd", other: ", sorted #th" })}`,
      exportCsv: t`Export CSV`,
      actions: t`Actions`,
      actionsFor: (name) => t`Actions for ${name}`,
      open: (name) => t`Open ${name}`,
      close: (name) => t`Close ${name}`,
      noneYet: (many) => t`No ${many} yet.`,
      noMatch: (many, query) => t`No ${many} match “${query}”.`,
      noneMeet: (many) => t`No ${many} meet the filter.`,
      loading: (many) => t`Loading ${many}`,
      loadingMore: (many) => t`Loading more ${many}`,
      failed: (many) => t`The ${many} did not load`,
      failedDetail: t`Check the connection, then try again.`,
      tryAgain: t`Try again`,
      pages: (label) => {
        const name = label.toLowerCase();
        return t`Pages of ${name}`;
      },
      rows: {
        one: t({ message: "row", context: "a table's rows, counted" }),
        other: t({ message: "rows", context: "a table's rows, counted" }),
      },
    },
    dataTableFilters: {
      contains: t({ message: "contains", context: "a filter's operator" }),
      lacks: t({ message: "does not contain", context: "a filter's operator" }),
      atLeast: t({ message: "is at least", context: "a filter's operator" }),
      atMost: t({ message: "is at most", context: "a filter's operator" }),
      is: t({ message: "is", context: "a filter's operator" }),
      isNot: t({ message: "is not", context: "a filter's operator" }),
    },
    empty: { failed: t`This did not load` },
    fileUpload: {
      drop: t`Drop files here, or`,
      choose: t`Choose files`,
      uploading: t`Uploading`,
      done: t({ message: "Uploaded", context: "a file" }),
      failed: t`Could not upload`,
      retry: t`Try again`,
      files: t`Files`,
      doneLine: (size) => t`${size}, uploaded`,
      sent: (name) => t`${name} uploaded.`,
      notSent: (name) => t`Could not upload ${name}.`,
      remove: (name) => t`Remove ${name}`,
      refused: (name, reason) => refusedFile(name, reason, false),
    },
    imageWell: {
      change: t`Change picture`,
      add: t`Add a picture`,
      remove: t`Remove picture`,
      saving: t`Saving`,
      saved: t`Saved`,
      failed: t`Could not save`,
      retry: t`Try again`,
      how: t`Click or drop a picture.`,
      refused: (name, reason) => refusedFile(name, reason, true),
    },
    agentActivity: {
      states: {
        waiting: t({ message: "Waiting", context: "a step's state" }),
        working: t({ message: "Working", context: "a step's state" }),
        done: t({ message: "Done", context: "a step's state" }),
        failed: t({ message: "Failed", context: "a step's state" }),
        skipped: t({ message: "Skipped", context: "a step's state" }),
      },
      showMore: t`Show more`,
      showLess: t`Show less`,
      input: t`Input`,
      result: t`Result`,
      error: t`Why it failed`,
      stepFailed: (title) => t`${title} failed`,
      summarize: (steps) => {
        const count = steps.length;
        return t`${plural(count, { one: "Took # step", other: "Took # steps" })}`;
      },
      name: t`Agent activity`,
      working: t`Working`,
    },
    appShell: {
      resize: t`Resize the panel`,
      breadcrumb: t`Breadcrumb`,
      menu: t`Menu`,
      closeMenu: t`Close the menu`,
      closePanel: t`Close the panel`,
      togglePanel: t`Show or hide the panel`,
    },
    chatMessage: {
      person: t`You`,
      failed: t`Could not answer`,
      retry: t`Try again`,
      actions: t`Message actions`,
      copy: t({ message: "Copy", context: "a message" }),
      copied: t`Copied`,
      copyFailed: t`Could not copy`,
      streaming: t`Writing`,
      done: t`Answer ready`,
      thinking: t`Thinking`,
      stopped: t({ message: "Stopped", context: "an answer stopped part way" }),
      thought: (seconds) =>
        t`${plural(seconds, { one: "Thought for # second", other: "Thought for # seconds" })}`,
    },
    markdown: {
      external: t`opens in a new tab`,
      back: (number) => t`Back to reference ${number}`,
      footnote: (number) => t`Footnote ${number}`,
      done: t`Done`,
      notDone: t`Not done`,
      table: t`Table`,
    },
    sources: {
      source: (number) => t`Source ${number}`,
      mention: (index) => t`mention ${index}`,
      gone: t`Could not be opened`,
      locked: t`You cannot open this`,
      goneInName: t`could not be opened`,
      lockedInName: t`you cannot open it`,
      count: (count) =>
        t`${plural(count, { 0: "No sources", one: "# source", other: "# sources" })}`,
      kind: (_kind, count) =>
        t`${plural(count, { 0: "No documents", one: "# document", other: "# documents" })}`,
      showMore: (count) => t`Show ${count} more`,
      showFewer: t`Show fewer`,
      order: t`Order`,
      byRelevance: t`By relevance`,
      byKind: t`By kind`,
      open: t`Show them`,
      close: t`Fold them away`,
      openRun: t`Open the run`,
      correct: t`Correct it`,
      heading: t`Sources`,
    },
    thread: {
      jump: t`Jump to latest`,
      unread: t`Unread`,
      unreadFrom: t`Unread messages from here`,
      loadingOlder: t`Loading older messages`,
      loading: t`Loading the conversation`,
      jumpToNew: (jump) => t`${jump}, new messages`,
      arrived: (count) =>
        t`${plural(count, { one: "# new message", other: "# new messages" })}`,
      today: t`Today`,
      yesterday: t`Yesterday`,
      day: (day, sameYear) => dayWritten(day, sameYear, i18n.locale),
    },
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
    avatarGroup: {
      more: (count) => t`+${count}`,
      // The names shown and how many more, joined as the language joins a list.
      name: (shown, rest) =>
        formatList(
          rest > 0
            ? [
                ...shown,
                t`${plural(rest, { one: "# other", other: "# others" })}`,
              ]
            : shown
        ),
    },
    calendar: {
      previous: t`Previous month`,
      next: t`Next month`,
      day: t({ message: "Day", context: "a calendar's grid of one day" }),
    },
    combobox: {
      empty: t`No results`,
      trigger: t`Show the choices`,
      failed: t({ message: "Failed", context: "a list row's action" }),
    },
    datePicker: { choose: t`Choose date` },
    dateRangePicker: {
      presets: t`Presets`,
      today: t`Today`,
      last7: t`Last 7 days`,
      last30: t`Last 30 days`,
      thisMonth: t`This month`,
    },
    languageSwitch: {
      label: t`Language`,
      search: t`Search languages`,
      clearSearch: t`Clear search`,
      suggested: t`Suggested`,
      all: t`All languages`,
      empty: t`No language found`,
      helpTranslate: t`Help translate`,
      button: (label, current) => t`${label}, ${current}`,
    },
    tagInput: {
      duplicate: (word) => t`“${word}” is already added.`,
      full: (most) => t`Up to ${most}.`,
      empty: t`Press Enter to add it.`,
      invalid: t({ message: "not valid", context: "a tag typed" }),
    },
    dialog: { close: t`Close` },
    sheet: { close: t`Close` },
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
