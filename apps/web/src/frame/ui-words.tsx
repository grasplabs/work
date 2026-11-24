import { I18nProvider } from "@grasp-os/ui/lib/i18n";
import type { I18nCatalog } from "@grasp-os/ui/lib/i18n";
import { plural, selectOrdinal } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

import { formatList } from "../format.ts";

/** A length of time as a screen reader says it: "1 hour, 2 minutes and 5 seconds". */
// Called while rendering, in the page's language, as the words below are.
const spokenTime = (seconds: number): string => {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  return formatList([
    ...(hours > 0 ? [plural(hours, { one: "# hour", other: "# hours" })] : []),
    ...(hours > 0 || minutes > 0
      ? [plural(minutes, { one: "# minute", other: "# minutes" })]
      : []),
    plural(rest, { one: "# second", other: "# seconds" }),
  ]);
};

/**
 * Every word Damsko's components say themselves ("Copied", "Show more",
 * "Close"), in the page's language. Damsko knows nothing of Lingui: its
 * components read their words from its own provider, which this fills
 * from the catalog, every part of Damsko's catalogue, so no component a
 * page takes up speaks English on a Dutch page. A word Damsko adds fails
 * the type check here until it has its translations.
 *
 * Inside Lingui's provider, once around the routes. Damsko's provider
 * keeps the words it has until the language or one of them changes.
 */
export const UiWords = ({ children }: { children: ReactNode }) => {
  const { t, i18n } = useLingui();

  /** A kind of file as people read it: ".pdf" is PDF, "image/svg+xml" SVG, "image/*" image files. */
  const fileType = (type: string): string => {
    const [kind = "", sub] = type.split("/");
    if (sub === undefined) {
      return kind.replace(/^\./u, "").toUpperCase();
    }
    if (sub === "*") {
      return t`${kind} files`;
    }
    return (sub.split("+")[0] ?? sub).toUpperCase();
  };

  /** A hunk's lines on one side: "lines 12 to 18", "line 4", "no lines". */
  const linesOf = (start: number, count: number): string => {
    // A side starts at 0 only when it has no lines (git's "-0,0").
    if (count === 0 || start === 0) {
      return t({ message: "no lines", context: "a change's lines" });
    }
    const end = start + count - 1;
    return count === 1
      ? t({ message: `line ${start}`, context: "a change's lines" })
      : t({ message: `lines ${start} to ${end}`, context: "a change's lines" });
  };

  /** A change's size: "2 removed and 3 added". */
  const sizeOf = (removed: number, added: number): string =>
    formatList([
      ...(removed > 0 ? [t`${removed} removed`] : []),
      ...(added > 0 ? [t`${added} added`] : []),
    ]);

  const catalog: I18nCatalog = {
    action: {
      agentAsks: t`Does something that needs your yes`,
      agentPresses: (words) => t`Presses "${words}"`,
      error: t`Could not finish`,
      loading: t`Working`,
      success: t`Done`,
    },
    alert: {
      close: t({ message: "Dismiss", context: "close a notice" }),
    },
    alertDialog: {
      cancel: t({ message: "Cancel", context: "leave a question unanswered" }),
    },
    attachment: {
      remove: (name) => t`Remove ${name}`,
    },
    audioPlayer: {
      back: t`Back 10 seconds`,
      error: t`Could not play this file`,
      forward: t`Forward 10 seconds`,
      loading: t`Loading the sound`,
      pause: t`Pause`,
      play: t`Play`,
      playbackRate: t({ message: "Speed", context: "how fast a sound plays" }),
      position: t({ message: "Position", context: "where a sound is at" }),
      soundOn: t`Turn sound on`,
      soundOff: t`Turn sound off`,
      timeOf: (now, length) => {
        const at = spokenTime(now);
        const whole = spokenTime(length);
        return t`${at} of ${whole}`;
      },
    },
    avatar: {
      groupCount: (count) => `+${String(count)}`,
      groupName: (shown, rest) =>
        rest === 0
          ? formatList(shown)
          : formatList([
              ...shown,
              plural(rest, { one: "# other", other: "# others" }),
            ]),
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
    breadcrumb: {
      ellipsis: t`Show hidden levels`,
      name: t`Breadcrumb`,
    },
    calendar: {
      next: t`Next month`,
      previous: t`Previous month`,
    },
    carousel: {
      carousel: t({ message: "carousel", context: "what a carousel is" }),
      next: t({ message: "Next", context: "the next slide" }),
      page: (page) => t`Page ${page}`,
      pages: (label) => t`Pages of ${label}`,
      previous: t({ message: "Previous", context: "the slide before" }),
      slide: t({ message: "slide", context: "what a carousel's slide is" }),
      slideLabel: (slide, count) => t`${slide} of ${count}`,
    },
    chainOfThought: {
      name: t({ message: "Steps", context: "how an answer was thought out" }),
    },
    chart: {
      described: (label, summary) => t`${label}. ${summary}`,
      flow: (source, target) => t`${source} → ${target}`,
      flowLabel: ({ source, target, value, share }) =>
        t`${source} to ${target}: ${value}, ${share}`,
      part: (name, value, share) => t`${name}: ${value}, ${share}`,
      partShare: (name, share) => t`${name} · ${share}`,
      point: (name, value) => t`${name}: ${value}`,
      pointAt: (label, points) => formatList([label, ...points]),
      shareOf: (share, source) => t`${share} of ${source}`,
      step: (name, value) => (name === "" ? value : t`${name} ${value}`),
    },
    codeBlock: {
      collapse: t`Show less`,
      expand: t`Show more`,
      moreLines: (count) =>
        plural(count, { one: "# more line", other: "# more lines" }),
      plainText: t({ message: "Text", context: "a code block's language" }),
      streaming: t({ message: "Writing", context: "a text being written" }),
    },
    combobox: {
      empty: t({ message: "No results", context: "a search finds nothing" }),
      notChoice: (value) => t`${value} is not one of the choices`,
      trigger: t`Show the choices`,
    },
    command: {
      dialogPlaceholder: t`Type a command or search`,
      dialogTrigger: t({
        message: "Search",
        context: "a command list's field",
      }),
      empty: t`No results`,
      error: t({ message: "Failed", context: "a list row's action" }),
      expand: (label) => t`More for ${label}`,
      loading: t({ message: "Searching", context: "a list fetching results" }),
      moreHint: t`Right arrow for more`,
      placeholder: t({ message: "Search", context: "a command list's field" }),
    },
    confirmation: {
      approved: t`Approved`,
      declined: t`Declined`,
      failed: t({
        message: "Failed",
        context: "an answer that did not go through",
      }),
    },
    context: {
      title: t({ message: "Context", context: "what a model reads" }),
      progress: t`Context used`,
      trigger: (percent) => t`${percent} context`,
      used: (used, max) => t`${used} / ${max}`,
      totalCost: t`Total cost`,
      kinds: {
        input: t({ message: "Input", context: "a model's tokens" }),
        output: t({ message: "Output", context: "a model's tokens" }),
        reasoning: t({ message: "Reasoning", context: "a model's tokens" }),
        cache: t({ message: "Cache", context: "a model's tokens" }),
      },
    },
    copyButton: {
      copied: t`Copied`,
      copy: t`Copy`,
      copyError: t`Not copied`,
    },
    dataGrid: {
      cell: (column, row) => {
        const number = String(row);
        return t`${column}, row ${number}`;
      },
      cleared: t`Cleared`,
      copied: t`Copied`,
      cut: t({ message: "Cut", context: "cells cut out" }),
      edit: (cell) => t`Edit ${cell}`,
      invalid: (column, kind) => t`${column} takes ${kind}`,
      pasted: t`Pasted`,
      readOnly: t`Read only`,
      redone: t`Redone`,
      row: t({ message: "Row", context: "a grid's row" }),
      selected: (count, from, to, top, bottom) =>
        plural(count, {
          one: `# cell chosen: ${from} to ${to}, rows ${top} to ${bottom}`,
          other: `# cells chosen: ${from} to ${to}, rows ${top} to ${bottom}`,
        }),
      takes: { figure: t`a figure`, option: t`one of its options` },
      ticked: t`Ticked`,
      undone: t`Undone`,
      unticked: t`Not ticked`,
      width: (header) => t`Width of ${header}`,
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
    datePicker: {
      last30: t`Last 30 days`,
      last7: t`Last 7 days`,
      presets: t({ message: "Presets", context: "ranges of dates to pick" }),
      rangeEnd: (field) => t`${field}, end`,
      rangeStart: (field) => t`${field}, start`,
      rangeTrigger: t`Choose dates`,
      select: t`Choose date`,
      triggerWith: (trigger, chosen) => t`${trigger}, ${chosen}`,
      thisMonth: t`This month`,
      today: t({ message: "Today", context: "a date to pick" }),
    },
    dialog: {
      close: t({ message: "Close", context: "close a dialog or panel" }),
    },
    diffViewer: {
      accept: t`Accept`,
      accepted: t`Accepted`,
      added: t({ message: "Added", context: "a changed line" }),
      after: t({ message: "After", context: "a change's new side" }),
      before: t({ message: "Before", context: "a change's old side" }),
      change: t({ message: "Change", context: "one change in a file" }),
      changeOf: (at, of, removed, added) => {
        const size = sizeOf(removed, added);
        return t`Change ${at} of ${of}: ${size}`;
      },
      counts: (added, removed) => {
        const plus = plural(added, {
          0: "No lines added",
          one: "# line added",
          other: "# lines added",
        });
        const minus = plural(removed, {
          0: "none removed",
          other: "# removed",
        });
        return t`${plus}, ${minus}`;
      },
      filesAdded: t({ message: "Added", context: "a file" }),
      filesDeleted: t({ message: "Deleted", context: "a file" }),
      filesFilesChanged: (files) =>
        plural(files, {
          0: "No files changed",
          one: "# file changed",
          other: "# files changed",
        }),
      filesModified: t({ message: "Modified", context: "a file" }),
      filesNothing: t`No files changed.`,
      hunk: (oldStart, oldCount, newStart, newCount) => {
        const before = linesOf(oldStart, oldCount);
        const after = linesOf(newStart, newCount);
        return t`${before} before, ${after} after`;
      },
      lineAfter: t`Line after`,
      lineBefore: t`Line before`,
      lines: (name) => t`${name}, lines`,
      name: t({ message: "Changes", context: "a list of changes" }),
      filesName: t`Changed files`,
      nothing: t`Nothing changed.`,
      reject: t`Reject`,
      rejected: t`Rejected`,
      removed: t({ message: "Removed", context: "a changed line" }),
      said: (at, decision) =>
        decision === null
          ? t`Change ${at} back to undecided`
          : t`Change ${at} ${decision}`,
      same: t`Nothing changed: both are the same.`,
      text: t({ message: "Text", context: "a file's kind" }),
      unchanged: (count) =>
        plural(count, {
          one: "Show # unchanged line",
          other: "Show # unchanged lines",
        }),
      undo: t`Undo`,
    },
    drawer: {
      handle: t({ message: "Resize", context: "a drawer's handle" }),
    },
    dropdownMenu: {
      expand: t`More actions`,
    },
    empty: {
      error: t`This did not load`,
    },
    field: {
      statusError: t`Could not save. Your choice is kept.`,
      statusLoading: t({ message: "Saving", context: "a setting saving" }),
      statusRetry: t`Try again`,
      statusSuccess: t({ message: "Saved", context: "a setting saved" }),
    },
    fileUpload: {
      added: (count) =>
        plural(count, { one: "# file added", other: "# files added" }),
      doneLine: (size) => t`${size}, uploaded`,
      drop: t`Drop files here, or`,
      error: t`Could not upload`,
      files: t`Files`,
      limits: (types, maxSize) => {
        const kinds = new Intl.ListFormat(i18n.locale, {
          type: "disjunction",
        }).format(types.map(fileType));
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
        const count = names.length;
        return count === 1 && only !== undefined
          ? t`${only} removed`
          : plural(count, {
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
    holdButton: {
      ask: (words) => t`${words}?`,
      cancel: t`Cancel`,
      confirm: t`Confirm`,
      holdTo: (words) => t`Press and hold: ${words}`,
    },
    imageUpload: {
      add: t`Add a picture`,
      change: t`Change picture`,
      error: t`Could not save`,
      how: t`Click or drop a picture.`,
      refused: (name, reason) => {
        if (reason === "file-too-large") {
          return t`${name} is too large.`;
        }
        return reason === "file-too-small"
          ? t`${name} is empty.`
          : t`${name} is not a kind of picture this takes.`;
      },
      refusedInRow: (reason) => {
        if (reason === "file-too-large") {
          return t`Too large.`;
        }
        return reason === "file-too-small"
          ? t`That file is empty.`
          : t`Not a kind of picture this takes.`;
      },
      remove: t`Remove picture`,
      retry: t`Try again`,
      retryTip: t`Could not save. Try again?`,
      saved: t`Saved`,
      saving: t`Saving`,
    },
    inlineCitation: {
      trigger: (host, more) => (more > 0 ? t`${host} +${more}` : host),
      unknown: t({ message: "Source", context: "where a citation comes from" }),
      sources: t({ message: "Sources", context: "where an answer comes from" }),
      index: (current, count) => t`${current}/${count}`,
    },
    inlineEdit: {
      edit: t({ message: "Edit", context: "edit a value in place" }),
      error: t`Could not save`,
      saved: (value) => t`Changed to ${value}`,
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
    link: {
      external: t`opens in a new tab`,
    },
    markdown: {
      back: (number) => t`Back to reference ${number}`,
      done: t({ message: "Done", context: "a task in a list" }),
      footnote: (number) => t`Footnote ${number}`,
      notDone: t({ message: "Not done", context: "a task in a list" }),
      table: t({ message: "Table", context: "a table in a text" }),
    },
    menu: {
      // On a menu item, and said, when the work it started failed; not a
      // run's status, which other languages word otherwise.
      error: t({ message: "Failed", context: "a menu item whose work failed" }),
      loading: t`Working`,
    },
    message: {
      actions: t`Message actions`,
      assistant: t({ message: "Assistant", context: "who wrote a message" }),
      done: t`Answer ready`,
      error: t`Could not answer`,
      retry: t`Try again`,
      stopped: t({ message: "Stopped", context: "an answer" }),
      streaming: t({ message: "Writing", context: "a text being written" }),
      user: t({ message: "You", context: "who wrote a message" }),
    },
    messageScroller: {
      arrived: (count) =>
        plural(count, { one: "# new message", other: "# new messages" }),
      jumpToNew: (jumpLabel) => t`${jumpLabel}, new messages`,
      label: t({ message: "Messages", context: "a conversation's messages" }),
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
    numberField: {
      decrement: t`Decrease`,
      increment: t`Increase`,
    },
    pagination: {
      loading: t`Loading the page`,
      name: t`Pagination`,
      next: t`Next page`,
      none: (unit) => t`No ${unit}`,
      page: (current, count) => t`Page ${current} of ${count}`,
      previous: t`Previous page`,
      range: (first, last, total, unit) =>
        t`Showing ${first} – ${last} of ${total} ${unit}`,
      unit: { one: t`item`, other: t`items` },
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
    reasoning: {
      done: t({ message: "Thought", context: "a model's thinking, over" }),
      thinking: t({ message: "Thinking", context: "a model at work" }),
      thought: (seconds) =>
        plural(seconds, {
          one: "Thought for # second",
          other: "Thought for # seconds",
        }),
    },
    sheet: {
      close: t({ message: "Close", context: "close a dialog or panel" }),
    },
    sidePanel: {
      close: t({ message: "Close", context: "close a dialog or panel" }),
      showAll: t`Show all`,
      views: t({ message: "Views", context: "a side panel's views" }),
    },
    sidebar: {
      main: t`Main`,
      name: t`Sidebar`,
      toggle: t`Show or hide the sidebar`,
    },
    sources: {
      count: (count) =>
        plural(count, {
          0: "No sources",
          one: "# source",
          other: "# sources",
        }),
      gone: t`Could not be opened`,
      heading: t({ message: "Sources", context: "where an answer comes from" }),
      locked: t`You cannot open this`,
      newTab: t`(opens in a new tab)`,
    },
    stackTrace: {
      copy: t`Copy the stack trace`,
      error: t({ message: "Error", context: "a program's error" }),
      frames: t`Stack frames`,
      noFrames: t`No stack frames`,
    },
    stepper: {
      count: (step, total) => t`Step ${step} of ${total}`,
      current: (step, total, label) => t`Step ${step} of ${total}: ${label}`,
      finished: t`All steps done`,
      navBack: t`Back`,
      navNext: t({ message: "Next", context: "the next step" }),
      states: {
        complete: t({ message: "done", context: "a step's state" }),
        active: t({ message: "current step", context: "a step's state" }),
        pending: t({ message: "not started", context: "a step's state" }),
        error: t({ message: "failed", context: "a step's state" }),
      },
    },
    suggestion: {
      name: t`Suggestions`,
    },
    switch: {
      error: t`Could not save`,
    },
    table: {
      sortIndex: (place) =>
        selectOrdinal(place, {
          one: "sorted #st",
          two: "sorted #nd",
          few: "sorted #rd",
          other: "sorted #th",
        }),
    },
    tableOfContents: {
      collapsed: (label) => t`${label}, folded`,
      open: (title) => t`${title}: Show the sections`,
      title: t`On this page`,
    },
    tabs: {
      close: (name) => t`Close ${name}`,
    },
    tagsInput: {
      duplicate: (word) => t`“${word}” is already added.`,
      empty: t`Press Enter to add it.`,
      full: (most) => t`Up to ${most}.`,
      invalid: t`not valid`,
    },
    terminal: {
      clear: t`Clear the output`,
      cleared: t`Output cleared`,
      copy: t`Copy the output`,
      output: t`Terminal output`,
      title: t`Terminal`,
    },
    testResults: {
      duration: (milliseconds) =>
        milliseconds < 1000
          ? new Intl.NumberFormat(i18n.locale, {
              style: "unit",
              unit: "millisecond",
              unitDisplay: "narrow",
              maximumFractionDigits: 0,
            }).format(milliseconds)
          : new Intl.NumberFormat(i18n.locale, {
              style: "unit",
              unit: "second",
              unitDisplay: "narrow",
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }).format(milliseconds / 1000),
      progress: (passed, total) =>
        plural(total, {
          one: `${passed} of # test passed`,
          other: `${passed} of # tests passed`,
        }),
      ran: (total, failed, skipped) =>
        formatList([
          plural(total, { one: "Ran # test", other: "Ran # tests" }),
          ...(failed > 0 ? [t`${failed} failed`] : []),
          ...(skipped > 0 ? [t`${skipped} skipped`] : []),
        ]),
      skipped: (name) => t`Skipped ${name}`,
      stats: (passed, failed, skipped) =>
        formatList([
          ...(passed > 0 ? [t`${passed} passed`] : []),
          ...(failed > 0 ? [t`${failed} failed`] : []),
          ...(skipped > 0 ? [t`${skipped} skipped`] : []),
        ]),
    },
    themeToggle: {
      // No line under a mode's tile: each is drawn as what it is, and its
      // name says the rest.
      dark: { name: t`Dark`, line: "" },
      icon: (label, current, next) =>
        t`${label}, ${current}. Switch to ${next}`,
      label: t`Theme`,
      light: { name: t`Light`, line: "" },
      // Said to an agent that asks for a mode or theme there is none of:
      // English, as the agent reads it.
      noMode: (mode, modes) =>
        `No mode "${mode}" in Theme. Its modes: ${modes.join(", ")}.`,
      noTheme: (theme, known) =>
        `No theme "${theme}" in Theme. Its themes: ${known.join(", ")}.`,
      system: { name: t`System`, line: "" },
      themes: t`Colours`,
    },
    toast: {
      close: t`Close`,
      error: t`Could not finish`,
      loading: t`Still working`,
      name: t`Notifications`,
    },
    tool: {
      error: t({ message: "Error", context: "a tool's result" }),
      input: t({ message: "Input", context: "what a tool was given" }),
      output: t({ message: "Output", context: "what a tool gave back" }),
      states: {
        "input-streaming": t({ message: "Pending", context: "a tool's state" }),
        "input-available": t({ message: "Running", context: "a tool's state" }),
        "approval-requested": t({
          message: "Awaiting approval",
          context: "a tool's state",
        }),
        "approval-responded": t({
          message: "Responded",
          context: "a tool's state",
        }),
        "output-available": t({
          message: "Completed",
          context: "a tool's state",
        }),
        "output-error": t({ message: "Error", context: "a tool's state" }),
        "output-denied": t({ message: "Denied", context: "a tool's state" }),
      },
    },
    trace: {
      states: {
        running: t({ message: "Working", context: "a step's state" }),
        error: t({ message: "Failed", context: "a step's state" }),
        pending: t({ message: "Waiting", context: "a step's state" }),
      },
    },
    treeView: {
      clear: t`Clear the filter`,
      empty: t`No matches`,
      filter: t({ message: "Filter", context: "a tree's filter field" }),
    },
  };
  return (
    <I18nProvider catalog={catalog} locale={i18n.locale}>
      {children}
    </I18nProvider>
  );
};
