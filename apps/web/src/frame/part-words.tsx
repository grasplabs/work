import { plural, selectOrdinal } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

import { useApprovalWords } from "../chat/approval-words.ts";
import { formatBytes, formatList, formatNumber } from "../format.ts";
import { agentActivityWords } from "../grasp/agent-activity/words.ts";
import { alertWords } from "../grasp/alert/words.ts";
import { appBuildingWords } from "../grasp/app-building/words.ts";
import { englishLabels as appCardWords } from "../grasp/app-card/words.ts";
import {
  englishFailure as appPreviewFailureWords,
  englishLabels as appPreviewWords,
  englishStopped as appPreviewStoppedWords,
} from "../grasp/app-preview/words.ts";
import { appShellPanelWords, appShellWords } from "../grasp/app-shell/words.ts";
import { approvalRequestWords } from "../grasp/approval-request/words.ts";
import {
  artifactViewerBoxWords,
  englishLabels as artifactViewerWords,
} from "../grasp/artifact-viewer/words.ts";
import { audioPlayerWords } from "../grasp/audio-player/words.ts";
import { avatarGroupWords } from "../grasp/avatar/words.ts";
import {
  backdropPickerWords,
  backdropPreviewWords,
} from "../grasp/backdrop/words.ts";
import { badgeWords } from "../grasp/badge/words.ts";
import { appIntegrationWords } from "../grasp/blocks/app-integration/words.ts";
import { connectAppWords } from "../grasp/blocks/connect-app/connect-app.tsx";
import { connectServiceWords } from "../grasp/blocks/connect-service/connect-service.tsx";
import { breadcrumbWords } from "../grasp/breadcrumb/words.ts";
import { buttonWords } from "../grasp/button/words.ts";
import { calendarWords } from "../grasp/calendar/words.ts";
import { carouselWords } from "../grasp/carousel/words.ts";
import { chatMessageWords } from "../grasp/chat-message/words.ts";
import { codeBlockWords } from "../grasp/code-block/words.ts";
import { comboboxWords } from "../grasp/combobox/words.ts";
import { commandWords } from "../grasp/command/words.ts";
import { composerWords } from "../grasp/composer/words.ts";
import { connectionRowWords } from "../grasp/connection-row/words.ts";
import { contextMenuWords } from "../grasp/context-menu/words.ts";
import { copyFieldWords } from "../grasp/copy-field/words.ts";
import { englishWords as dataGridWords } from "../grasp/data-grid/words.ts";
import {
  dataTableWords,
  englishFilterWords,
} from "../grasp/data-table/words.ts";
import { datePickerWords } from "../grasp/date-picker/words.ts";
import { dateRangePickerWords } from "../grasp/date-range-picker/words.ts";
import { dialogWords } from "../grasp/dialog/words.ts";
import { diffFilesWords } from "../grasp/diff-files/words.ts";
import { diffWords } from "../grasp/diff/words.ts";
import { draftWords } from "../grasp/draft/words.ts";
import type { DraftWords } from "../grasp/draft/words.ts";
import { drawerWords } from "../grasp/drawer/words.ts";
import { dropdownMenuWords } from "../grasp/dropdown-menu/words.ts";
import { emptyWords } from "../grasp/empty/words.ts";
import { fileUploadWords, imageWellWords } from "../grasp/file-upload/words.ts";
import { filterBuilderWords } from "../grasp/filter-builder/words.ts";
import { inputWords } from "../grasp/input/words.ts";
import { englishWords as inspectorPanelWords } from "../grasp/inspector-panel/words.ts";
import { englishWords as interviewWords } from "../grasp/interview/words.ts";
import { keyValueWords } from "../grasp/key-value/words.ts";
import { languageSwitchWords } from "../grasp/language-switch/words.ts";
import { linkWords } from "../grasp/link/words.ts";
import { markdownWords } from "../grasp/markdown/words.ts";
import { multiStepFormWords } from "../grasp/multi-step-form/words.ts";
import { ownerPickerWords } from "../grasp/owner-picker/words.ts";
import { paginationWords } from "../grasp/pagination/words.ts";
import { panelWords } from "../grasp/panel/words.ts";
import { questionToolWords } from "../grasp/question-tool/words.ts";
import { sectionCardWords } from "../grasp/section-card/words.ts";
import { settingRowWords } from "../grasp/setting-row/words.ts";
import { shareAccessWords } from "../grasp/share-access/words.ts";
import { sheetWords } from "../grasp/sheet/words.ts";
import { sidebarWords } from "../grasp/sidebar/words.ts";
import { signInWords } from "../grasp/sign-in/words.ts";
import { sourcesWords } from "../grasp/sources/words.ts";
import { stepBarWords } from "../grasp/step-bar/words.ts";
import { stepFootWords } from "../grasp/step-foot/words.ts";
import { stepperWords } from "../grasp/stepper/words.ts";
import { tabsWords } from "../grasp/tabs/words.ts";
import { tagInputWords } from "../grasp/tag-input/words.ts";
import { tagWords } from "../grasp/tag/words.ts";
import { themeSwitchWords } from "../grasp/theme-switch/words.ts";
import { dayWritten } from "../grasp/thread/rows.ts";
import { threadWords } from "../grasp/thread/words.ts";
import { toasterWords } from "../grasp/toast/words.ts";
import { treeWords } from "../grasp/tree/words.ts";
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

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

/** A day ("Thu 19 Nov") in `locale`, in the zone given. */
const dayIn = (locale: string, iso: string, timeZone: string | undefined) =>
  new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone,
  }).format(new Date(iso));

/** A time of day ("14:00") in `locale`, in the zone given. */
const clockIn = (locale: string, iso: string, timeZone: string | undefined) =>
  new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));

/**
 * The drafts' words in English, the library's own but for a task's due:
 * the tasks Grasp makes (Microsoft To Do, Planner) are due on a day, never
 * at a time, so its row says the day alone.
 */
const englishDraftWords: DraftWords = {
  ...draftWords,
  task: {
    ...draftWords.task,
    at: (iso, timeZone) => dayIn("en-GB", iso, timeZone),
  },
};

/** Every installed part's words in English: the library's own. */
export const englishPartWords: GraspWordsCatalog = {
  "app-shell-panel": appShellPanelWords,
  agentActivity: agentActivityWords,
  alert: alertWords,
  appBuilding: appBuildingWords,
  artifactViewer: artifactViewerWords,
  artifactViewerBox: artifactViewerBoxWords,
  appCard: appCardWords,
  appPreview: appPreviewWords,
  appPreviewFailure: appPreviewFailureWords,
  appPreviewStopped: appPreviewStoppedWords,
  appShell: appShellWords,
  approvalRequest: approvalRequestWords,
  audioPlayer: audioPlayerWords,
  avatarGroup: avatarGroupWords,
  backdropPicker: backdropPickerWords,
  backdropPreview: backdropPreviewWords,
  badge: badgeWords,
  breadcrumb: breadcrumbWords,
  calendar: calendarWords,
  combobox: comboboxWords,
  command: commandWords,
  composer: composerWords,
  contextMenu: contextMenuWords,
  datePicker: datePickerWords,
  dateRangePicker: dateRangePickerWords,
  languageSwitch: languageSwitchWords,
  tabs: tabsWords,
  tagInput: tagInputWords,
  tree: treeWords,
  button: buttonWords,
  chatMessage: chatMessageWords,
  codeBlock: codeBlockWords,
  copyField: copyFieldWords,
  dataGrid: dataGridWords,
  dataTable: dataTableWords,
  dataTableFilters: englishFilterWords,
  diff: diffWords,
  diffFiles: diffFilesWords,
  dialog: dialogWords,
  stepBar: stepBarWords,
  stepFoot: stepFootWords,
  draft: englishDraftWords,
  drawer: drawerWords,
  dropdownMenu: dropdownMenuWords,
  empty: emptyWords,
  fileUpload: fileUploadWords,
  filterBuilder: filterBuilderWords,
  imageWell: imageWellWords,
  input: inputWords,
  inspectorPanel: inspectorPanelWords,
  keyValue: keyValueWords,
  link: linkWords,
  markdown: markdownWords,
  ownerPicker: ownerPickerWords,
  pagination: paginationWords,
  panel: panelWords,
  questionTool: questionToolWords,
  rename: renameWords,
  sectionCard: sectionCardWords,
  settingRow: settingRowWords,
  shareAccess: shareAccessWords,
  sheet: sheetWords,
  sidebar: sidebarWords,
  interview: interviewWords,
  multiStepForm: multiStepFormWords,
  sources: sourcesWords,
  stepper: stepperWords,
  tag: tagWords,
  themeSwitch: themeSwitchWords,
  thread: threadWords,
  toaster: toasterWords,
  carousel: carouselWords,
  connectionRow: connectionRowWords,
  connectService: connectServiceWords,
  appIntegration: appIntegrationWords,
  connectApp: connectAppWords,
  signIn: signInWords,
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
      columnInfo: (header) => t`More about ${header}`,
      groupAttention: t`needs attention`,
      noDate: t`No date`,
      rowPending: t({
        message: "pending",
        context: "a table row not yet in effect",
      }),
      rowRemoved: t({
        message: "removed",
        context: "a table row of something taken away",
      }),
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
      pagePanel: t({ message: "Details", context: "a page's side panel" }),
      breadcrumb: t`Breadcrumb`,
      menu: t`Menu`,
      closeMenu: t`Close the menu`,
      closePanel: t`Close the panel`,
      togglePanel: t`Show or hide the panel`,
      more: t`More actions`,
    },
    chatMessage: {
      person: t`You`,
      failed: t`Could not answer`,
      retry: t`Try again`,
      actions: t`Message actions`,
      copy: t({ message: "Copy", context: "a message" }),
      copied: t`Copied`,
      copyFailed: t`Not copied`,
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
    audioPlayer: {
      failed: t`Could not play this file`,
      loading: t`Loading the sound`,
    },
    // Times and passage numbers are the library's own: digits read the same in every language.
    interview: {
      ...interviewWords,
      length: (ms) => {
        const minutes = Math.max(1, Math.round(ms / MS_PER_MINUTE));
        return t`${minutes} min`;
      },
      atPassage: (number) => t`passage ${number}`,
      seek: (time, who) => t`Go to ${time}, ${who}`,
      transcript: t`Transcript`,
      timeline: t`Conversation timeline`,
      speakers: t`Speakers`,
      chapters: t`Chapters`,
      highlight: t({ message: "Highlight", context: "a marked moment" }),
      kinds: t`Kinds of highlight`,
      runs: t`Who spoke when`,
      run: (who, from, to) => t`${who}, ${from} to ${to}`,
      mark: (kind, time) => t`${kind} at ${time}`,
      count: (count, total) =>
        t`${plural(total, { one: `${count} of # interview`, other: `${count} of # interviews` })}`,
      player: (who, time) => t`${who} at ${time}`,
      sound: t`Interview sound`,
      origin: (how, said) =>
        [
          t({ message: "Interview", context: "where a quote comes from" }),
          how,
          said,
        ]
          .filter((part) => part !== undefined && part !== "")
          .join(" · "),
      search: t`Search the transcript`,
      previousMatch: t`Previous match`,
      nextMatch: t`Next match`,
      matchOf: (index, count) => t`${index} of ${count}`,
      noMatches: t`No matches`,
    },
    multiStepForm: {
      back: t`Back`,
      next: t`Next`,
      submit: t`Send`,
      failed: t`Could not send`,
      page: t({ message: "Page", context: "one page of a form" }),
      counter: (page, total) => t`${page} of ${total}`,
    },
    stepper: {
      states: {
        done: t({ message: "done", context: "a step's state" }),
        current: t({ message: "current step", context: "a step's state" }),
        coming: t({ message: "not started", context: "a step's state" }),
        failed: t({ message: "failed", context: "a step's state" }),
      },
      count: (step, total) => t`Step ${step} of ${total}`,
      finished: t`All steps done`,
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
      more: t`More actions`,
      expand: t`Full screen`,
      collapse: t`Leave full screen`,
      width: t`Resize the panel's width`,
      height: t`Resize the panel's height`,
      close: t`Close`,
    },
    alert: { dismiss: t`Dismiss` },
    // The viewer shows a page (the weekly report) and nothing else here:
    // the words a person meets in that mode are translated. Comments,
    // editing, PDF, tables and images are not installed, so their words
    // stay the library's own until a page uses them.
    artifactViewer: {
      ...artifactViewerWords,
      file: t({
        message: "File",
        context: "an opened file's name before it has one",
      }),
      untitled: t`Untitled`,
      opening: (name) =>
        name === undefined ? t`Opening the file` : t`Opening ${name}`,
      notOpened: t`It did not open`,
      didNotLoad: t`The file did not load.`,
      loadFailed: (status) => t`The file did not load (${status}).`,
      unknownKind: t`This kind of file does not show here`,
      download: (name) => t`Download ${name}`,
      start: t({ message: "Start", context: "the start of a file" }),
      zoom: (zoom) => (zoom === "fit" ? t`Fit` : `${zoom}%`),
      previousSection: t`Previous section`,
      nextSection: t`Next section`,
      zoomIn: t`Zoom in`,
      zoomOut: t`Zoom out`,
      zoomToFit: t`Zoom to fit`,
      showOutline: t`Show the outline`,
      hideOutline: t`Hide the outline`,
      outline: t`Outline`,
      view: t({
        message: "View",
        context: "a file shown as a page or as code",
      }),
      preview: t`Preview`,
      code: t`Code`,
      showCode: t`Show the code`,
      showPreview: t`Show the preview`,
      more: t`More`,
      shortcuts: t`Keyboard shortcuts`,
      find: t`Find in the file`,
      noMatches: t`No matches`,
      previousMatch: t`Previous match`,
      nextMatch: t`Next match`,
      closeFind: t`Close find`,
      findInPreview: t`Counted in the page's words. Code view marks them in its source.`,
      usePage: t`Use the page`,
      usePageHint: t`Press to use the page`,
      usePageDone: t`Done`,
      pageLeft: t`This page kept leaving`,
      pageLeftBody: (times) =>
        t`It sent itself to another address ${times} times, so it is no longer shown. Its source is in Code view.`,
    },
    artifactViewerBox: {
      file: t({
        message: "File",
        context: "an opened file's name before it has one",
      }),
    },
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
      actionFailed: t`Could not finish`,
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
    diff: {
      name: t({ message: "Changes", context: "a diff's name" }),
      accept: t({ message: "Accept", context: "a change in a diff" }),
      reject: t({ message: "Reject", context: "a change in a diff" }),
      undo: t`Undo`,
      accepted: t({ message: "Accepted", context: "a change in a diff" }),
      rejected: t({ message: "Rejected", context: "a change in a diff" }),
      added: t({ message: "Added", context: "a line a change adds" }),
      removed: t({ message: "Removed", context: "a line a change removes" }),
      before: t({ message: "Before", context: "a diff's old side" }),
      after: t({ message: "After", context: "a diff's new side" }),
      lineBefore: t`Line before`,
      lineAfter: t`Line after`,
      change: t({ message: "Change", context: "one change in a diff" }),
      text: t({ message: "Text", context: "a diff's text" }),
      nothing: t`Nothing changed.`,
      same: t`Nothing changed: both are the same.`,
      unchanged: (count) =>
        plural(count, {
          one: "Show # unchanged line",
          other: "Show # unchanged lines",
        }),
      changeOf: (at, of, removed, added) =>
        t`Change ${at} of ${of}: ${removed} removed, ${added} added`,
      counts: (added, removed) =>
        t`${plural(added, { 0: "No lines added", one: "# line added", other: "# lines added" })}, ${plural(removed, { 0: "none removed", other: "# removed" })}`,
      said: (at, decision) => {
        if (decision === null) {
          return t`Change ${at} back to undecided`;
        }
        return decision === "accepted"
          ? t`Change ${at} accepted`
          : t`Change ${at} rejected`;
      },
      lines: (name) => t`${name}, lines`,
      hunk: (oldStart, oldCount, newStart, newCount) => {
        const oldEnd = oldStart + oldCount - 1;
        const newEnd = newStart + newCount - 1;
        // A side starts at 0 only when it has no lines (git's "-0,0").
        const before = oldStart === 0 ? 0 : oldCount;
        const after = newStart === 0 ? 0 : newCount;
        return t`${plural(before, { 0: "No lines before", one: `Line ${oldStart} before`, other: `Lines ${oldStart} to ${oldEnd} before` })}, ${plural(after, { 0: "no lines after", one: `line ${newStart} after`, other: `lines ${newStart} to ${newEnd} after` })}`;
      },
    },
    diffFiles: {
      name: t({
        message: "What changes",
        context: "the files a change touches",
      }),
      added: t({ message: "Added", context: "a file a change adds" }),
      deleted: t({ message: "Deleted", context: "a file a change removes" }),
      modified: t({ message: "Modified", context: "a file a change changes" }),
      filesChanged: (files) =>
        plural(files, {
          0: "No files changed",
          one: "# file changed",
          other: "# files changed",
        }),
      counts: (added, removed) =>
        t`${plural(added, { 0: "No lines added", one: "# line added", other: "# lines added" })}, ${plural(removed, { 0: "none removed", other: "# removed" })}`,
      nothing: t`No files changed.`,
    },
    stepBar: {
      back: t`Back`,
      next: t`Next`,
      step: (step, total) => t`Step ${step} of ${total}`,
    },
    stepFoot: {
      back: t`Back`,
      next: t`Next`,
      step: (step, total) => t`Step ${step} of ${total}`,
    },
    codeBlock: {
      copy: t`Copy code`,
      copied: t`Copied`,
      copyFailed: t`Not copied`,
      writing: t`Writing`,
      more: t`Show more`,
      less: t`Show less`,
    },
    copyField: { copied: t`Copied`, failed: t`Not copied` },
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
    command: {
      placeholder: t({ message: "Search", context: "a command list's field" }),
      empty: t`No results`,
      failed: t({ message: "Failed", context: "a list row's action" }),
      loading: t({ message: "Searching", context: "a list fetching results" }),
      more: (label) => t`More for ${label}`,
      moreHint: t`Right arrow for more`,
      dialogTrigger: t({
        message: "Search",
        context: "a command list's field",
      }),
      dialogPlaceholder: t`Type a command or search`,
    },
    input: {
      showPassword: t`Show password`,
      hidePassword: t`Hide password`,
      replace: t({ message: "Replace", context: "a secret key, typed again" }),
    },
    composer: {
      composer: {
        failed: t`Could not send`,
        working: t`Grasp is answering`,
        success: t({ message: "Done", context: "an answer is done" }),
        send: t({ message: "Send", context: "send the question" }),
        stop: t({ message: "Stop", context: "stop the answer" }),
        drop: t`Drop to add`,
        dictate: t`Dictate`,
        uploading: t`Sending waits for the files to upload`,
        attachments: t`Files to send`,
        commands: t`Commands`,
        mentions: t({ message: "Mention", context: "the mention menu" }),
        mentionsEmpty: t`Nothing found`,
        mentionsLoading: t`Looking`,
        mentionsFound: (count) =>
          t`${plural(count, { one: "# result", other: "# results" })}`,
        image: (number) => t`Image ${number}`,
        screenshots: t`Screenshots`,
        pictureTime: (at) =>
          at.toLocaleTimeString(i18n.locale, {
            hour: "2-digit",
            minute: "2-digit",
          }),
        pictureRemoved: (label) => t`${label} removed`,
        count: (length, max) => `${formatNumber(length)}/${formatNumber(max)}`,
        near: (max) => {
          const limit = formatNumber(max);
          return t`Close to the limit of ${limit} characters`;
        },
        reached: (max) => {
          const limit = formatNumber(max);
          return t`The limit of ${limit} characters is reached`;
        },
        cut: (max) => {
          const limit = formatNumber(max);
          return t`The pasted text was cut at the limit of ${limit} characters`;
        },
      },
      add: {
        label: t`Add to the question`,
        actions: t`This chat`,
        upload: t`Attach a file`,
        agent: t({ message: "Agent", context: "who answers a chat" }),
      },
      attachment: {
        uploading: t`Uploading`,
        done: t({ message: "Uploaded", context: "a file" }),
        failed: t`Could not upload`,
        retry: t`Try again`,
        remove: t`Remove`,
        size: formatBytes,
        pages: (count) =>
          t`${plural(count, { one: "# page", other: "# pages" })}`,
      },
      model: {
        label: t`Model`,
        search: t`Search models`,
        makers: t`Makers`,
        favourites: t`Favourites`,
        empty: t`No models found`,
      },
      modelEffort: {
        label: t`Model and effort`,
        model: t`Model`,
        effort: t`How hard it thinks`,
        none: t`This model has one level of effort.`,
        thinking: t({
          message: "Thinking",
          context: "how hard a model thinks",
        }),
      },
      reasoning: { label: t`How hard it thinks` },
      agent: {
        label: t({ message: "Agent", context: "who answers a chat" }),
        search: t`Search agents`,
        empty: t`No agents found`,
        back: (agent) => t`Back to ${agent}`,
      },
      queue: {
        queued: (count) =>
          t`${plural(count, { one: "# queued", other: "# queued" })}`,
        edit: (text) => t`Edit: ${text}`,
        sendNow: (text) => t`Send now: ${text}`,
        remove: (text) => t`Remove: ${text}`,
      },
      voice: {
        asking: t`Asking for the microphone`,
        askingShort: t`Asking…`,
        listening: t`Listening`,
        speaking: t`Speaking`,
        thinking: t`Writing it down`,
        silent: t`Paused`,
        muted: t`Muted`,
        close: t`Close voice`,
        done: t`Done`,
        cancel: t`Cancel`,
        mute: t`Mute`,
        unmute: t`Unmute`,
        retry: t`Try again`,
        level: t`Level`,
        problems: {
          blocked: t`The microphone is blocked for this site.`,
          missing: t`No microphone was found.`,
          unsupported: t`This browser can't dictate.`,
          unheard: t`A part couldn't be made out. What came before is kept.`,
          failed: t`The words couldn't be written down. What you typed is kept.`,
          limited: t`That's as long as one dictation can be.`,
        },
        // Minutes and seconds, as every language here writes them.
        time: composerWords.voice.time,
      },
    },
    contextMenu: {
      failed: t({ message: "Failed", context: "a list row's action" }),
    },
    ownerPicker: {
      placeholder: t`Choose an owner`,
      empty: t`No one has that name`,
      trigger: t`Show the people`,
    },
    shareAccess: {
      find: t`Add people or groups`,
      inviteLevel: t`Access for who you add`,
      invite: t({ message: "Invite", context: "give someone access" }),
      failedInvite: t`Could not invite`,
      list: t`People with access`,
      owner: t({ message: "Owner", context: "who owns what is shared" }),
      you: t({ message: "(you)", context: "after the person's own name" }),
      level: (name) => t`Access for ${name}`,
      remove: t`Remove`,
      preview: t`What they will see`,
      copyLink: t`Copy link`,
      copied: t`Link copied`,
      copyFailed: t`Not copied`,
      done: t({ message: "Done", context: "close the share dialog" }),
      pick: t`Add people, teams or projects`,
      add: t({ message: "Add", context: "add someone to share with" }),
      added: t`Has access`,
      noMatch: t`No one by that name`,
      searching: t({
        message: "Searching",
        context: "a list fetching results",
      }),
      address: (address) => t`Invite ${address}`,
      unpick: (name) => t`Remove ${name}`,
    },
    appBuilding: {
      name: t`Grasp is building`,
      layout: t({ message: "Layout", context: "who builds an app's look" }),
      data: t({ message: "Data", context: "who builds an app's data" }),
      copy: t({ message: "Words", context: "who writes an app's words" }),
    },
    appCard: {
      more: t`More actions`,
      building: t`Being built`,
      failed: t`Didn't start`,
      empty: t`No preview yet`,
      newApp: t`New app`,
    },
    appPreview: {
      region: t`App preview`,
      reload: t`Reload`,
      open: t`Open in a new tab`,
      address: t`Address`,
      widths: t({ message: "Width", context: "a preview's screen width" }),
      phone: t({ message: "Phone", context: "a screen width" }),
      tablet: t`Tablet`,
      desktop: t`Desktop`,
      fit: t({ message: "Fit", context: "a preview fitted to its room" }),
      building: t`Building the app`,
      loading: t`Loading the app`,
      ready: t`The app is running`,
      updating: t`Updating the app`,
      stopped: t`The app is asleep`,
      use: t`Use the app`,
      useHint: t`Press to use the app`,
      done: t({ message: "Done", context: "stop using the app's preview" }),
      details: t`Technical details`,
      more: t`More`,
      fullscreen: t`Full screen`,
      leaveFullscreen: t`Leave full screen`,
      copy: t`Copy link`,
      copied: t`Link copied`,
      copyFailed: t`Could not copy the link`,
      back: t`Back`,
      forward: t`Forward`,
    },
    appPreviewFailure: {
      title: t`The app didn't start`,
      description: t`The server stopped before the app was ready.`,
      retry: t`Try again`,
    },
    appPreviewStopped: {
      title: t`The app is asleep`,
      description: t`It stopped after a while unused. Starting it takes a few seconds.`,
      start: t`Start the app`,
    },
    backdropPicker: {
      names: {
        cliffs: t`Cliffs`,
        wave: t`Wave`,
        aurora: t`Aurora`,
        starry: t`Starry night`,
        fuji: t`Fuji`,
        wanderer: t`Wanderer`,
        dusk: t`Dusk`,
        dots: t`Dots`,
        door: t`Door`,
        sand: t`Sand`,
        dunes: t`Dunes`,
        rings: t`Rings`,
        pixels: t`Pixel sand`,
        none: t`None`,
      },
      patterns: { bayer: t`Bayer`, grid: t`Grid`, mix: t`Bayer grid` },
      tones: {
        light: t`Light`,
        deep: t`Deep`,
        mint: t`Mint`,
        lime: t`Lime`,
        ink: t`Ink`,
        rim: t`Dark edge`,
        core: t`Light edge`,
        aurora: t`Aurora`,
      },
      scenes: t`Scenes`,
      dithers: t`Dithers`,
      sand: t`Sand`,
      backdrop: t`Background`,
      backdropHint: t`A scene, a dither, sand, or nothing.`,
      pattern: t`Pattern`,
      patternHint: t`How the dither's cells are set.`,
      tone: t`Colour`,
      toneHint: t`One green, or a run of greens from the edge in.`,
      previewTitle: t`What should we look at today?`,
      previewLabel: t`Preview of your chat background`,
      randomize: t`Randomize`,
    },
    backdropPreview: {
      title: t`What should we look at today?`,
      placeholder: t`Ask anything, or describe a process`,
      label: t`Preview of your chat background`,
    },
    breadcrumb: {
      name: t`Breadcrumb`,
      hidden: t`Show hidden levels`,
    },
    drawer: { resize: t`Resize` },
    filterBuilder: {
      field: t({ message: "Field", context: "a filter condition's part" }),
      operator: t({
        message: "Operator",
        context: "a filter condition's part",
      }),
      value: t({ message: "Value", context: "a filter condition's part" }),
      name: t`Filter condition`,
      segments: {
        field: t`Filter field`,
        operator: t`Filter operator`,
        value: t`Filter value`,
      },
    },
    inspectorPanel: {
      add: t({ message: "Add", context: "add to an inspector's list" }),
      none: t({ message: "Not set", context: "a fact with no value" }),
      addTo: (label) => {
        const what = label.toLowerCase();
        return t`Add ${what}`;
      },
      remove: (name) => t`Remove ${name}`,
      showAll: (label) => {
        const what = label.toLowerCase();
        return t`Show all the ${what}`;
      },
      close: t`Close`,
      views: t({ message: "Views", context: "an inspector's views" }),
    },
    keyValue: {
      copy: (name) => {
        const what = name.toLowerCase();
        return t`Copy ${what}`;
      },
      copied: t`Copied`,
      failed: t`Could not copy`,
      pending: t`Loading the value`,
    },
    panel: {
      close: t`Close`,
      views: t({ message: "Views", context: "a panel's views" }),
      showAll: t`Show all`,
    },
    questionTool: {
      other: t({ message: "Other", context: "an answer of one's own" }),
      name: t`Question`,
      submit: t`Send answer`,
      skip: t`Skip`,
      back: t`Back`,
      recommended: t`Recommended`,
      step: (step, count) => t`${step} of ${count}`,
      failed: t`Could not send the answer`,
    },
    datePicker: { choose: t`Choose date` },
    dateRangePicker: {
      trigger: t`Choose date`,
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
    tabs: { close: (name) => t`Close ${name}` },
    tree: {
      filter: t`Filter`,
      clear: t`Clear the filter`,
      noMatches: t`No matches`,
    },
    tagInput: {
      duplicate: (word) => t`“${word}” is already added.`,
      full: (most) => t`Up to ${most}.`,
      empty: t`Press Enter to add it.`,
      invalid: t({ message: "not valid", context: "a tag typed" }),
    },
    dialog: { close: t`Close` },
    // Only a sheet's draft has a grid, which no page shows yet: the
    // library's own words until one does.
    dataGrid: dataGridWords,
    // The kinds a held write stands as (an email, an event, a task) and
    // their frame. A reply, a sheet and a message aren't shown yet: their
    // words stay the library's own until a page uses them. Dates and
    // times are Intl's, in the page's language.
    draft: {
      ...draftWords,
      frame: {
        dismiss: t({ message: "Discard", context: "a draft" }),
        dismissed: t`Draft discarded`,
        restore: t({ message: "Restore", context: "a discarded draft" }),
        undo: t`Undo`,
        working: t`Working`,
        failed: t`Try again`,
        remove: (name) => t`Remove ${name}`,
        you: t({ message: "You", context: "the person looking, in a draft" }),
      },
      email: {
        kind: t({ message: "Email", context: "a draft's kind" }),
        to: t({ message: "To", context: "an email's addressees" }),
        cc: t({ message: "Cc", context: "an email's copies" }),
        bcc: t({ message: "Bcc", context: "an email's blind copies" }),
        subject: t({ message: "Subject", context: "an email's" }),
        body: t({ message: "Message", context: "an email's body" }),
        addCc: t({ message: "Cc / Bcc", context: "show an email's copies" }),
        send: t({ message: "Send", context: "send an email" }),
        attach: t`Attach a file`,
        sent: t({ message: "Sent", context: "an email" }),
        time: (iso, timeZone) => clockIn(i18n.locale, iso, timeZone),
      },
      event: {
        kind: t({ message: "Event", context: "a calendar event" }),
        title: t`Event name`,
        create: t`Create event`,
        open: t`Open in calendar`,
        created: t`Added to the calendar`,
        day: t`The day, with everyone's busy time`,
        conflicts: t({ message: "Conflicts", context: "an event's" }),
        busy: (name, from, to) => t`${name}: busy ${from} to ${to}`,
        when: t({ message: "When", context: "an event's time" }),
        starts: t({ message: "Starts", context: "an event's start" }),
        ends: t({ message: "Ends", context: "an event's end" }),
        people: t({ message: "People", context: "an event's guests" }),
        call: t`Video call`,
        place: t({ message: "Place", context: "where an event is" }),
        description: t({ message: "Description", context: "an event's" }),
        addPlace: t({ message: "Add a place", context: "an event's" }),
        addDescription: t`Add a description`,
        time: (iso, timeZone) => clockIn(i18n.locale, iso, timeZone),
        span: (start, end, timeZone) => {
          const day = dayIn(i18n.locale, start, timeZone);
          const from = clockIn(i18n.locale, start, timeZone);
          const to = clockIn(i18n.locale, end, timeZone);
          return `${day} · ${from} → ${to}`;
        },
        lasts: (start, length, timeZone) => {
          const from = clockIn(i18n.locale, start, timeZone);
          const hours = Math.floor(length / MINUTES_PER_HOUR);
          const minutes = length % MINUTES_PER_HOUR;
          if (hours === 0) {
            return `${from} · ${t`${minutes} min`}`;
          }
          return minutes === 0
            ? `${from} · ${t`${hours} h`}`
            : `${from} · ${t`${hours} h ${minutes} min`}`;
        },
      },
      task: {
        kind: t({ message: "Task", context: "a draft's kind" }),
        title: t`Task name`,
        add: t`Add task`,
        added: t`Added to your tasks`,
        due: t({ message: "Due", context: "when a task is due" }),
        people: t({ message: "Who", context: "who does a task" }),
        note: t({ message: "Note", context: "a task's" }),
        addDue: t`Add a due date`,
        addNote: t`Add a note`,
        time: (iso, timeZone) => clockIn(i18n.locale, iso, timeZone),
        // A day alone: the tasks Grasp makes are due on a day (englishDraftWords).
        at: (iso, timeZone) => dayIn(i18n.locale, iso, timeZone),
        // A due date alone ("2026-11-20"): that day, wherever it is read.
        on: (date) => dayIn(i18n.locale, `${date}T00:00:00Z`, "UTC"),
      },
      eventChange: {
        kind: t({ message: "Event change", context: "a draft's kind" }),
        save: t`Save changes`,
        saved: t`Event updated`,
        was: t({ message: "Was", context: "a value before a change" }),
        added: t({ message: "New", context: "a guest a change adds" }),
        removed: t({
          message: "Removed",
          context: "a guest a change takes off",
        }),
      },
    },
    dropdownMenu: {
      working: t({ message: "Working", context: "a menu item's action" }),
      more: t`More actions`,
    },
    link: { external: t`opens in a new tab` },
    sectionCard: { info: t`More about this section` },
    themeSwitch: {
      label: t({ message: "Theme", context: "light, dark or as the device" }),
      themes: t({ message: "Colours", context: "a choice of colour themes" }),
      light: {
        name: t({ message: "Light", context: "a theme's mode" }),
        line: t`Always light`,
      },
      dark: {
        name: t({ message: "Dark", context: "a theme's mode" }),
        line: t`Always dark`,
      },
      system: {
        name: t({ message: "System", context: "a theme's mode" }),
        line: t`As your device`,
      },
      icon: (label, current, next) =>
        t`${label}, ${current}. Switch to ${next}`,
    },

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
      hintPress: t`Press or press F2 to rename`,
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
      loading: t`Loading`,
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
    carousel: {
      previous: t`Previous`,
      next: t`Next`,
      pages: (label) => t`Pages of ${label}`,
      page: (page) => t`Page ${page}`,
    },
    connectionRow: {
      whoCanFix: t`Who can fix this`,
      notWorking: t`Not working`,
    },
    connectService: {
      change: t`Change`,
      key: t`Key`,
      keyNote: t`Only its last four characters are shown again.`,
      keyMissing: t`Paste the key.`,
      address: t`Address`,
      // An address, the same in every language.
      addressPlaceholder: "https://models.example.com/v1",
      addressMissing: t`Enter your endpoint's address.`,
      addressWrong: t`Enter an address that starts with https://.`,
      connect: t`Connect`,
      connecting: t`Connecting`,
      connected: t`Connected`,
      notConnected: t`Not connected`,
      replaceKey: t`Replace key`,
      disconnect: t`Disconnect`,
      disconnectTitle: (label) => t`Disconnect ${label}?`,
      disconnectDetail: t`Grasp's chat, agents and workflows stop using it, and its key is removed. Connecting again takes a new key.`,
      keep: t`Keep it`,
      disconnecting: t`Disconnecting`,
      notDisconnected: t`Could not disconnect`,
      keyLine: (last, region) =>
        region === undefined ? t`Key …${last}` : t`Key …${last} · ${region}`,
      connectName: (label) => t`Connect ${label}`,
    },
    appIntegration: {
      connect: t`Connect`,
      connectAgain: t`Connect again`,
      manage: t`Manage`,
      settings: t`Settings`,
      signInAgain: t`Sign in again`,
      connectAnother: t`Connect another account`,
      disconnect: t`Disconnect`,
      close: t`Close`,
      tools: (toolCount) =>
        t`${plural(toolCount, { one: "# tool", other: "# tools" })}`,
      allowed: (allowed, total) =>
        t`${plural(total, { one: `${allowed} of # tool allowed`, other: `${allowed} of # tools allowed` })}`,
      needsSignIn: t`Sign in again`,
      needsConnect: t`Connect again`,
      account: t`Account`,
      connection: t`Connection`,
      signedInAs: t`Signed in as`,
      forWhom: t`For`,
      forYou: t`Only you`,
      forEveryone: t`Everyone`,
      connectedBy: t`Connected by`,
      status: t`Status`,
      works: t({ message: "Connected", context: "state of one app" }),
      signedOut: t({ message: "Signed out", context: "state of one app" }),
      stopped: t({ message: "Stopped working", context: "state of one app" }),
      notConnected: t`Not connected`,
      canDo: t`What Grasp can do`,
      mayDo: t`What Grasp may do`,
      counts: (reads, writes) =>
        t({
          message: `${reads} read · ${writes} change`,
          comment:
            "How many of an app's tools only read, and how many change something.",
        }),
      readCount: (count) =>
        t({
          message: `${count} read`,
          comment: "How many of an app's tools only read.",
        }),
      changeCount: (count) =>
        t({
          message: `${count} change`,
          comment: "How many of an app's tools change something.",
        }),
      balance: (reads, writes) =>
        t`${plural(reads, { one: `# tool reads, ${writes} change`, other: `# tools read, ${writes} change` })}`,
      allTools: (count) =>
        t`${plural(count, { one: "The # tool", other: "All # tools" })}`,
      usedBy: t`Used by`,
      notUsed: t`Not used yet`,
      workflow: t`Workflow`,
      agent: t`Agent`,
      whoCanUse: t`Who can use it`,
      searchTools: t`Search tools`,
      noMatch: t`No tool matches`,
      never: t({ message: "Never", context: "what a tool may do" }),
      read: t({ message: "Read", context: "what a tool may do" }),
      write: t({ message: "Write", context: "what a tool may do" }),
      mixed: t({ message: "Mixed", context: "what a tool may do" }),
      neverNote: t`Grasp doesn't use these`,
      readNote: t`Reads without asking, changes nothing`,
      writeNote: t`Reads, and asks before each change`,
      mixedNote: t`Set tool by tool`,
      toolReadNote: t`Runs without asking`,
      toolWriteNote: t`Asks before each run`,
      choiceOf: (name) => t`What Grasp may do: ${name}`,
      showTools: (group, count) =>
        t`${plural(count, { one: `Show the # ${group} tool`, other: `Show the # ${group} tools` })}`,
      other: t`Other`,
      readsWord: t`Reads`,
      changesWord: t`Changes`,
    },
    connectApp: {
      title: (app) => t`Connect ${app}`,
      titleAgain: (app) => t`Connect ${app} again`,
      summaryAll: t`Read everything, ask before changes`,
      summaryRead: t`Read everything, change nothing`,
      summaryNone: t`Nothing yet`,
      summaryMixed: t`Set group by group`,
      change: t`Change`,
      done: t`Done`,
      whoUses: t`Who uses it`,
      forEveryone: t`Everyone in the organization`,
      forYou: t`Just you`,
      consentFrom: (provider) =>
        t({
          message: `Consent · ${provider}`,
          comment: "{provider} keeps the access, such as Composio.",
        }),
      cancel: t`Cancel`,
      connect: t`Connect`,
    },
    signIn: {
      // The product's name: never translated.
      brand: "Grasp",
      title: t`Log in`,
      way: (provider) => t`Continue with ${provider}`,
      leaving: (provider) => t`Opening ${provider}`,
      opened: t`Opened`,
      notOpened: t`Did not open`,
      lastUsed: t`Last used`,
      staff: t`Continue with Grasp staff`,
      staffTitle: t`Grasp staff`,
      guestTitle: t`Talk to Grasp`,
      back: t`Back to Grasp`,
      foot: t`New to Grasp?`,
      footAction: t`Talk to us`,
      notices: {
        ended: t`Your session ended. Log in to carry on.`,
        soon: t`Grasp opens for everyone soon. If you have an interview link, it is in your email.`,
        offline: t`You're offline. Log in when you're back online.`,
        notMember: t`That account isn't part of your organisation.`,
        guest: t`Guest accounts can't sign in.`,
        timedOut: t`Sign-in timed out. Try again.`,
        noAccess: t`You don't have access to this organisation. Ask an admin.`,
        unreachable: t`Grasp can't be reached right now. Try again in a minute.`,
      },
    },
    toaster: {
      name: t`Notifications`,
      failed: t`Not done`,
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
      // In English the parts speak as the library wrote them, but for the
      // chat's box, whose words are work's own ("Add to the question",
      // "Grasp is answering"), as the rest of the chat says them.
      words={
        i18n.locale === "en"
          ? { ...englishPartWords, composer: translated.composer }
          : translated
      }
    >
      {children}
    </GraspWords>
  );
};
