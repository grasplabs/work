// The few words the components say themselves ("Close", "Copied", "Show more"), in English, and the
// one way a product gives them in its own language. A product wraps each React root once, with its
// catalogue for the page's language:
//
//   <I18nProvider locale="nl-NL" catalog={nl}>…</I18nProvider>
//
// and a component reads its words, by its own part:
//
//   const { dialog } = useI18n();   dialog.close
//
// The catalogue may be a constant per language, or built while rendering from a translation
// library whose words exist only once a language is active (a runtime catalogue):
//
//   const { t, i18n } = useTranslations();
//   <I18nProvider locale={i18n.locale} catalog={{ dialog: { close: t("Close") } }}>…</I18nProvider>
//
// Either way the provider keeps the words it has until `locale` or a string changes, so what reads
// them is not drawn again because the object is a new one (I18nProvider, below). `locale` is
// always given: a word that is a function is read again when it changes.
//
// A part the catalogue leaves out keeps its English, and a part it gives, it gives whole: every
// word of it, so a word added here fails the product's type check until it is translated. With no
// provider everything is English. Words built from others are functions ("Hold to delete").
// Numbers and dates follow `useLocale()`. No part's name starts with `use`: the React Compiler
// reads such a member as a hook.
"use client";

import { createContext, use, useState } from "react";
import type { ReactNode } from "react";

/** A part of a time with its plural: "2 minutes", "1 second". */
const timePart = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/** A time as a screen reader says it: "1 hour 2 minutes 5 seconds", "5 seconds". */
const spokenTime = (seconds: number) => {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  return [
    hours > 0 && timePart(hours, "hour"),
    (hours > 0 || minutes > 0) && timePart(minutes, "minute"),
    timePart(whole % 60, "second"),
  ]
    .filter(Boolean)
    .join(" ");
};

/** A count of characters, with its plural: "1 character", "120 characters". */
const englishCharacters = (count: number) =>
  count === 0
    ? "no characters"
    : `${count} ${count === 1 ? "character" : "characters"}`;

/** A place in a sort, in words: "first", "second". */
const places = ["first", "second", "third", "fourth", "fifth"];

/** A change's size, in English: "2 removed, 3 added". */
const sizesOf = (removed: number, added: number) =>
  [removed > 0 ? `${removed} removed` : "", added > 0 ? `${added} added` : ""]
    .filter((each) => each !== "")
    .join(", ");

/** A kind of file as people read it: ".pdf" → "PDF", "image/svg+xml" → "SVG", "image/*" → "image files". */
const fileType = (type: string) => {
  const [kind = "", sub] = type.split("/");
  if (sub === undefined) {
    return kind.replace(/^\./u, "").toUpperCase();
  }
  return sub === "*"
    ? `${kind} files`
    : (sub.split("+")[0] ?? sub).toUpperCase();
};

/** Words in a list, the last after "or": "PDF, PNG or JPG". */
const orList = (words: readonly string[]) =>
  words.length < 2
    ? words.join("")
    : `${words.slice(0, -1).join(", ")} or ${words.at(-1) ?? ""}`;

/** A hunk's lines on one side, in English: "lines 12 to 18", "line 4", "no lines". */
const englishLines = (start: number, count: number) => {
  // A side starts at 0 only when it has no lines (git's "-0,0").
  if (count === 0 || start === 0) {
    return "no lines";
  }
  return count === 1
    ? `line ${start}`
    : `lines ${start} to ${start + count - 1}`;
};

/**
 * Every component's words, by part (the component's name in camel case): their English below, the
 * product's through I18nProvider.
 */
export interface I18nCatalog {
  /** The words of an action's states (hooks/use-action.ts): Button, Hold button, Inline edit, a menu's item. */
  action: {
    /** What an agent is told before it presses a danger or approve button with no words. */
    agentAsks: string;
    /** What an agent is told before it presses a danger or approve button, from its words. */
    agentPresses: (words: string) => string;
    /**
     * An action whose work failed when the host gives no `errorLabel` of its own: neutral, as the
     * work may be a save, a check or a send. Dialog's, Alert dialog's, Drawer's and Popover's actions.
     */
    error: string;
    /** Said to a screen reader while it works, when no `loadingLabel` is given. */
    loading: string;
    success: string;
  };
  alert: {
    /** The banner look's dismiss button, named for a screen reader. */
    close: string;
  };
  alertDialog: {
    /** The safe answer AlertDialogCancel gives when it is given no words of its own. */
    cancel: string;
  };
  attachment: {
    /** A file's remove action, named for it ("Remove brief.pdf"). */
    remove: (name: string) => string;
  };
  audioPlayer: {
    /** The button that goes back ten seconds. */
    back: string;
    /** The words when the file cannot be played, in place of the controls. */
    error: string;
    /** The button that goes on ten seconds. */
    forward: string;
    /** What the play button says while the file is slow to come. */
    loading: string;
    pause: string;
    play: string;
    /** Said before the rate on its button ("Speed 1.5×"). */
    playbackRate: string;
    /** The timeline's thumb. */
    position: string;
    /** The sound button while the sound is off. */
    soundOn: string;
    /** The sound button while the sound is on. */
    soundOff: string;
    /** Where the sound is, as the timeline says it, in seconds ("1 minute 5 seconds of 3 minutes"). */
    timeOf: (now: number, length: number) => string;
  };
  avatar: {
    groupCount: (count: number) => string;
    groupName: (shown: readonly string[], rest: number) => string;
  };
  badge: {
    /** The dot's name when it stands alone (`dot` with no words), by its variant. */
    dot: {
      default: string;
      success: string;
      warning: string;
      destructive: string;
      info: string;
    };
    /** The remove button's name, when the words are not text. */
    remove: string;
    /** The remove button's name, from the badge's words. */
    removeNamed: (words: string) => string;
  };
  breadcrumb: {
    /** The button that shows the levels folded away in the middle. */
    ellipsis: string;
    /** Its name, as a navigation landmark. */
    name: string;
  };
  calendar: {
    /** The button to the month after. */
    next: string;
    /** The button to the month before. */
    previous: string;
  };
  carousel: {
    /** What a screen reader calls the whole (`aria-roledescription`). */
    carousel: string;
    next: string;
    page: (page: number) => string;
    pages: (label: string) => string;
    previous: string;
    /** What a screen reader calls one slide (`aria-roledescription`). */
    slide: string;
    /** A slide's name when it has none of its own ("2 of 5"). */
    slideLabel: (slide: number, count: number) => string;
  };
  chainOfThought: {
    /** Its name, for a screen reader, when the caller gives none (`aria-label`). */
    name: string;
  };
  chart: {
    /** A figure named by its label and its summary at once, as a picture is ("Revenue by week. Up 8%."). */
    described: (label: string, summary: string) => string;
    /** A Sankey's flow from one stage to the next, read out under the drawing ("Received → Paid"). */
    flow: (source: string, target: string) => string;
    /** A Sankey's flow as a screen reader says it ("Received to Paid: 812, 67% of Received"). */
    flowLabel: (flow: {
      source: string;
      target: string;
      value: string;
      share: string;
    }) => string;
    /** A pie's part as a screen reader says it ("E-invoice: 612, 50%"). */
    part: (name: string, value: string, share: string) => string;
    /** A pie's part in its centre, under its value ("E-invoice · 50%"). */
    partShare: (name: string, share: string) => string;
    /** One series' value at a point ("Solved: 40"). */
    point: (name: string, value: string) => string;
    /** The point the keys are on, said as they move: its name along the bottom, then each series' `point`. */
    pointAt: (label: string, points: readonly string[]) => string;
    /** A Sankey flow's share of the stage it came from ("67% of Received"). */
    shareOf: (share: string, source: string) => string;
    /** A sparkline's point as the keys reach it ("Week 7 €12.4k"); its name may be empty. */
    step: (name: string, value: string) => string;
  };
  codeBlock: {
    /** Show less's words. */
    collapse: string;
    /** Show more's words. */
    expand: string;
    /** Under the last line drawn of a very long block: how many lines are not drawn. */
    moreLines: (count: number) => string;
    /** The language's name in the head for plain text (`language="text"`). */
    plainText: string;
    /** The words in the head while it is still being written. */
    streaming: string;
  };
  combobox: {
    /** Said in the list when nothing matches. */
    empty: string;
    notChoice: (value: string) => string;
    /** The name of the button that opens the list. */
    trigger: string;
  };
  command: {
    /** CommandDialog's search field before anything is typed: a verb and the thing. */
    dialogPlaceholder: string;
    /** CommandDialog's trigger: the words on its button. */
    dialogTrigger: string;
    /** What the list says when nothing matches. */
    empty: string;
    /** What a failed command says when it has no `errorLabel` of its own. */
    error: string;
    /** The More button's name, from the command's words. */
    expand: (label: string) => string;
    /** What the list says while results load. */
    loading: string;
    /** How to reach a result's More, said once to a screen reader. */
    moreHint: string;
    /** The search field's words before anything is typed. */
    placeholder: string;
  };
  confirmation: {
    approved: string;
    declined: string;
    /** On an answer's button when it did not get through, whichever answer it was. */
    failed: string;
  };
  context: {
    /** The card's heading. */
    title: string;
    /** The bar's name, for a screen reader. */
    progress: string;
    /** The trigger's words: the share of the window used, formatted ("8%"). */
    trigger: (percent: string) => string;
    /** The tokens used of the most, each formatted ("10.7K / 128K"). */
    used: (used: string, max: string) => string;
    /** The footer's label, before the total cost. */
    totalCost: string;
    /** Each usage row's label. */
    kinds: { input: string; output: string; reasoning: string; cache: string };
  };
  messageScroller: {
    /** What a screen reader hears for the messages that came in, from their count. */
    arrived: (count: number) => string;
    /** The way back down when a message has come in since the reader left, from the jump's words. */
    jumpToNew: (jumpLabel: string) => string;
    /** The log's name when it is given none. */
    label: string;
    /** Said once while the whole conversation loads (`loading`). */
    loading: string;
    /** The button that brings the person back down to the latest. */
    scrollToEnd: string;
    /** The button that brings the person up to the first message. */
    scrollToStart: string;
  };
  copyButton: {
    copied: string;
    copy: string;
    copyError: string;
  };
  dataGrid: {
    cell: (column: string, row: number) => string;
    cleared: string;
    copied: string;
    cut: string;
    edit: (cell: string) => string;
    invalid: (column: string, kind: string) => string;
    pasted: string;
    /** Said when a paste is refused because the grid cannot be changed. */
    readOnly: string;
    redone: string;
    row: string;
    selected: (
      count: number,
      from: string,
      to: string,
      top: number,
      bottom: number
    ) => string;
    takes: { figure: string; option: string };
    ticked: string;
    undone: string;
    unticked: string;
    width: (header: string) => string;
  };
  dataTable: {
    actions: string;
    actionsFor: (name: string) => string;
    cancel: string;
    chooseAll: (one: string) => string;
    chooseColumn: string;
    clear: string;
    clearSearch: string;
    close: (name: string) => string;
    columnInfo: (header: string) => string;
    columnMenu: (header: string) => string;
    columns: string;
    confirm: (action: string, count: number, unit: string) => string;
    confirmDetail: string;
    done: (action: string, count: number, unit: string) => string;
    error: (many: string) => string;
    exportCsv: string;
    failedDetail: string;
    filterAtLeast: string;
    filterAtMost: string;
    filterContains: string;
    /** The field's placeholder, before one is chosen. */
    filterField: string;
    filterIs: string;
    filterIsNot: string;
    filterLabel: (label: string) => string;
    filterLacks: string;
    /** The condition's name, as a group. */
    filterName: string;
    /** The operator's placeholder. */
    filterOperator: string;
    /** Each segment's name, for a screen reader. */
    filterSegments: { field: string; operator: string; value: string };
    /** The value's placeholder. */
    filterValue: string;
    groupAttention: string;
    hide: string;
    loading: (many: string) => string;
    loadingMore: (many: string) => string;
    moveEarlier: string;
    moveLater: string;
    noDate: string;
    noMatch: (many: string, query: string) => string;
    noneMeet: (many: string) => string;
    noneYet: (many: string) => string;
    open: (name: string) => string;
    pages: (label: string) => string;
    pinEnd: string;
    pinStart: string;
    rowPending: string;
    rowRemoved: string;
    search: (many: string) => string;
    searchLabel: (label: string) => string;
    select: (name: string) => string;
    selected: (count: number, total: number) => string;
    sortDown: string;
    sortNext: string;
    sortUp: string;
    tryAgain: string;
    undo: string;
    unpin: string;
    view: string;
    width: (header: string) => string;
    withChosen: (many: string) => string;
    /** What a row is called, one and many, when the table is given no `unit`. */
    unit: { one: string; other: string };
  };
  datePicker: {
    last30: string;
    last7: string;
    /** The name of a range's group of preset ranges. */
    presets: string;
    /** The name of a range's end field, from the picker's name. */
    rangeEnd: (field: string) => string;
    /** The name of a range's start field, from the picker's name. */
    rangeStart: (field: string) => string;
    /**
     * A range's calendar button's name, with the chosen range said after it (`triggerLabel`
     * replaces the whole name). Apart from `select`: other languages say dates in the plural.
     */
    rangeTrigger: string;
    /** The calendar button's name, when the field gives it none. */
    select: string;
    /** The calendar button's name with what is chosen said after it ("Choose date, 3 March"). */
    triggerWith: (trigger: string, chosen: string) => string;
    thisMonth: string;
    /** The four default preset ranges' names, in order (`presetLabels` gives all four at once). */
    today: string;
  };
  dialog: {
    /** The name of the close button in the corner. */
    close: string;
  };
  diffViewer: {
    accept: string;
    accepted: string;
    added: string;
    after: string;
    before: string;
    change: string;
    changeOf: (
      at: number,
      of: number,
      removed: number,
      added: number
    ) => string;
    counts: (added: number, removed: number) => string;
    filesAdded: string;
    filesDeleted: string;
    filesFilesChanged: (files: number) => string;
    filesModified: string;
    filesNothing: string;
    hunk: (
      oldStart: number,
      oldCount: number,
      newStart: number,
      newCount: number
    ) => string;
    lineAfter: string;
    lineBefore: string;
    lines: (name: string) => string;
    /** A diff's name for a screen reader, when it has no `title` or `aria-label`. */
    name: string;
    /** The file list's name for a screen reader, when it has no `aria-label`. */
    filesName: string;
    nothing: string;
    reject: string;
    rejected: string;
    removed: string;
    said: (at: number, decision: "accepted" | "rejected" | null) => string;
    same: string;
    text: string;
    unchanged: (count: number) => string;
    undo: string;
  };
  drawer: {
    /** The grip at the drawer's edge that resizes it. */
    handle: string;
  };
  dropdownMenu: {
    /** A "More" button's name (DropdownMenuMore), when it is given none. */
    expand: string;
  };
  empty: {
    /** An error's title when it is given none, so it is never read as an empty list. */
    error: string;
  };
  field: {
    /** Said when the save failed: what did not happen, and that the value is kept. */
    statusError: string;
    /** Said while it saves. */
    statusLoading: string;
    /** The button that saves again. */
    statusRetry: string;
    /** Said once it saved. */
    statusSuccess: string;
  };
  fileUpload: {
    /** Said once files join the list, from how many. */
    added: (count: number) => string;
    doneLine: (size: string) => string;
    drop: string;
    error: string;
    files: string;
    /**
     * What it takes, under the dropzone, when it is given no `description`: its kinds of file
     * (`accept`, as given) and its largest file, in words ("10 MB"); either may be missing.
     */
    limits: (types: readonly string[], maxSize: string | undefined) => string;
    notSent: (name: string) => string;
    refused: (name: string, reason: string) => string;
    remove: (name: string) => string;
    /** Said once files leave the list, from their names. */
    removed: (names: readonly string[]) => string;
    retry: string;
    select: string;
    sent: (name: string) => string;
    /** The line under a file while it is sent, from how far it has gone, in percent. */
    uploading: (percent: number) => string;
    /** The name of a file's progress bar while it is sent, from its name. */
    uploadingName: (name: string) => string;
  };
  holdButton: {
    /** A hold's confirmation title, from the button's words: "Delete draft?". */
    ask: (words: string) => string;
    /** The confirmation's way out. */
    cancel: string;
    /** The confirmation's title when the button has no words. */
    confirm: string;
    /** A hold's name while it is held, from the button's own words: "Hold to delete draft". */
    holdTo: (words: string) => string;
  };
  imageUpload: {
    add: string;
    change: string;
    error: string;
    how: string;
    refused: (name: string, reason: string) => string;
    refusedInRow: (reason: string) => string;
    remove: string;
    retry: string;
    /** The tooltip after a save failed: that it failed, and that a press tries again. */
    retryTip: string;
    saved: string;
    saving: string;
  };
  inlineCitation: {
    /** The chip's words: the first source's host, and how many more ("example.com +2"). */
    trigger: (host: string, more: number) => string;
    /** The host's place on the chip when the first source's address leads nowhere safe. */
    unknown: string;
    /** The carousel's name, for a screen reader, when the caller gives none (`aria-label`). */
    sources: string;
    /** Which source of how many, over the carousel ("1/3"). */
    index: (current: number, count: number) => string;
  };
  inlineEdit: {
    /** Said after the text: that a press opens it to be changed. */
    edit: string;
    /** Under the field when the save failed; the words typed are kept. */
    error: string;
    /** What a screen reader hears once the new value is saved. */
    saved: (value: string) => string;
  };
  input: {
    /** The same button while the password shows. */
    hidePassword: string;
    /** A saved secret's button that empties the field for a new one (SecretInput). */
    replace: string;
    /** The password field's button while the password is hidden. */
    showPassword: string;
  };
  keyValue: {
    /** A row's copy button, from the fact's name ("Copy email"). */
    copy: (label: string) => string;
    loading: string;
  };
  link: {
    /** Said after a link that opens in a new tab, as part of its name. */
    external: string;
  };
  markdown: {
    /** The link from a footnote back to where it is used, from its number. */
    back: (number: number) => string;
    /** What a ticked task says to a screen reader. */
    done: string;
    /** A footnote's mark, said to a screen reader, from its number. */
    footnote: (number: number) => string;
    /** What a task not yet ticked says. */
    notDone: string;
    /** A table's name when no heading stands above it (`tableLabel`). */
    table: string;
  };
  /** The menus' items: a context menu's and a menubar's. */
  menu: {
    /** Shown on an item and said when its work failed, unless it gives its own `errorLabel`. */
    error: string;
    /** Said as an item's work starts, unless it gives its own `loadingLabel`. */
    loading: string;
  };
  message: {
    /** The name of the row of actions under a message. */
    actions: string;
    /** The assistant's message's name, when it is given none. */
    assistant: string;
    /** Said to a screen reader once the agent has finished writing. */
    done: string;
    /** In place of an agent's message that could not be written. */
    error: string;
    /** The button that tries again after a failure. */
    retry: string;
    /** Under a message stopped part way, and said once when it stops. */
    stopped: string;
    /** Said to a screen reader while the agent writes. */
    streaming: string;
    /** The user's message's name, when it is given none. */
    user: string;
  };
  modelSelector: {
    /** When no model matches the search. */
    empty: string;
    /** The search field's name and placeholder. */
    search: string;
    /** The selector's name. */
    trigger: string;
    /** The selector's name with the model it shows ("Model: Fast"). */
    triggerWith: (trigger: string, model: string) => string;
    /** The column of makers' logos, for a screen reader. */
    makers: string;
    /** The column's star, and the list's heading under it. */
    favorites: string;
    /** Under the star while no model is a favourite. */
    noFavorites: string;
    /** The effort's heading at the panel's foot, and its group's name. */
    effort: string;
    /** A row's star while the model is not a favourite. */
    addFavorite: (model: string) => string;
    /** A row's star while the model is a favourite. */
    removeFavorite: (model: string) => string;
    /** Said when a model becomes a favourite. */
    added: (model: string) => string;
    /** Said when a model stops being a favourite. */
    removed: (model: string) => string;
    /** Said when a model is chosen and the panel stays open for its effort. */
    chosen: (model: string) => string;
    /** How the keys star the highlighted model, said with the search field. */
    favoriteKeys: string;
  };
  numberField: {
    /** The button that takes a step down. */
    decrement: string;
    /** The button that takes a step up. */
    increment: string;
  };
  pagination: {
    /** Said while the next page loads. */
    loading: string;
    /** Its name, for a page with more than one. */
    name: string;
    /** The name of the step on. */
    next: string;
    /** When there are none. */
    none: (unit: string) => string;
    /** The page beside the steps, for a screen reader. */
    page: (current: string, count: string) => string;
    /** The name of the step back. */
    previous: string;
    /** The range beside the steps: the first and last item shown, the total and what they are. */
    range: (first: string, last: string, total: string, unit: string) => string;
    /** What the items are called, by the language's plural forms (`one`, `other`, and any it has). */
    unit: Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
  };
  promptInput: {
    /** The action menu's plus: its name. */
    add: string;
    /** The action menu's row that opens the file picker. */
    addAttachments: string;
    /** The list of attached files: its name. */
    attachments: string;
    /** The count near the limit. */
    count: (length: number, max: number) => string;
    /** Said when what was added (a paste, a drop, a phrase, a mention) did not all fit. */
    cut: (max: number) => string;
    /** Over the card while files are dragged onto it. */
    drop: string;
    /** Said when a send failed, and shown on the band under the card. */
    failed: string;
    /** In the mention menu when nothing matches. */
    mentionEmpty: string;
    /** In the mention menu when its items could not be loaded. */
    mentionsError: string;
    /** Said with how many the mention menu found. */
    mentionsFound: (count: number) => string;
    /** In the mention menu while it looks. */
    mentionsLoading: string;
    /** Said once near the limit. */
    near: (max: number) => string;
    /** Said once at the limit. */
    reached: (max: number) => string;
    /**
     * The speech button: its name, and what it says while it listens, which names the bar that
     * stands in the footer then; the bar's Cancel, Done and microphone.
     */
    speechButton: {
      cancel: string;
      done: string;
      label: string;
      listening: string;
      mute: string;
      /** Said once as the product writes down what it heard, after Done. */
      settling: string;
    };
    /** Submit's name while the answer comes. */
    stop: string;
    /** Submit's name. */
    submit: string;
    /** Said once as the status comes to `success`. */
    succeeded: string;
    /**
     * A spoken conversation in the card: its name, its close button, and what is said as each
     * turn starts, the person's and the other voice's.
     */
    voice: {
      close: string;
      label: string;
      listening: string;
      speaking: string;
    };
  };
  questionnaire: {
    /** Under the card when the answers could not be sent, and given to an agent. */
    error: string;
    /** The button that goes on to the next question. */
    next: string;
    /** The row for an answer of one's own. */
    other: string;
    /** The button that goes back to the question before. */
    previous: string;
    /** Where the person is in the run, said to a screen reader ("Question 2 of 3"). */
    progress: (current: number, total: number) => string;
    /** Where the person is in the run, shown at the head's end ("2 of 3"). */
    step: (current: number, total: number) => string;
    /** The progress bar's name. */
    progressLabel: string;
    /** The mark on the recommended choice. */
    recommended: string;
    /** Under a question that cannot go on without an answer. */
    required: string;
    /** The button that skips the question. */
    skip: string;
    /** The button that sends the answers. */
    submit: string;
  };
  reasoning: {
    /** What the thinking line settles to when how long it took is not known. */
    done: string;
    /** The thinking line while the agent works. */
    thinking: string;
    /** What the thinking line settles to, from how many seconds it took. */
    thought: (seconds: number) => string;
  };
  sheet: {
    /** The name of the close button in the corner. */
    close: string;
  };
  sidePanel: {
    /** The header's close button. */
    close: string;
    /** PanelText's button that opens a long text in place. */
    showAll: string;
    /** The name of the header's views, as tabs. */
    views: string;
  };
  sidebar: {
    /** The main list's navigation, said as its landmark. */
    main: string;
    /** The sidebar's name, said as its landmark. */
    name: string;
    /** The fold button's name. */
    toggle: string;
  };
  sources: {
    count: (count: number) => string;
    gone: string;
    /** The list's name. */
    heading: string;
    locked: string;
    /** Said after a source's title, as its link opens in a new tab. */
    newTab: string;
  };
  stackTrace: {
    /** The copy button's name and tooltip. */
    copy: string;
    /** StackTraceError's words when the stack names neither a type nor a message. */
    error: string;
    /** The list of frames, as a screen reader names it. */
    frames: string;
    /** Shown in the frames' place when the stack has none. */
    noFrames: string;
  };
  stepper: {
    /** Which step of how many, said with the bar and shown beside it when asked ("Step 2 of 4"). */
    count: (step: number, total: number) => string;
    /** Where the stepper stands, said as it moves: which step of how many, and its name. */
    current: (step: number, total: number, label: string) => string;
    /** Said once every step is done. */
    finished: string;
    /** Back's name and tip: the step before. */
    navBack: string;
    /** Next's name and tip: the next step. */
    navNext: string;
    /** Said after a step, by its state. */
    states: {
      complete: string;
      error: string;
      active: string;
      pending: string;
    };
  };
  suggestion: {
    /** The row's name, for a screen reader, when the caller gives none (`aria-label`). */
    name: string;
  };
  switch: {
    /** Said under a switch and to a screen reader when its save failed (`errorLabel`). */
    error: string;
  };
  table: {
    /** A sorted column's description: its place among the sorts ("sorted second"). */
    sortIndex: (place: number) => string;
  };
  tableOfContents: {
    /** A section's link whose children are folded away, as a screen reader says it ("Settings, folded"). */
    collapsed: (label: string) => string;
    /** The compact form's button that shows the sections, named after the list's title. */
    open: (title: string) => string;
    /** The heading over the sections. */
    title: string;
  };
  tabs: {
    /** The name of a tab's close button: what it closes. */
    close: (name: string) => string;
  };
  tagsInput: {
    duplicate: (value: string) => string;
    empty: string;
    full: (max: number) => string;
    invalid: string;
  };
  terminal: {
    /** The clear button's name and tooltip. */
    clear: string;
    /** Said once the output is cleared. */
    cleared: string;
    /** The copy button's name and tooltip. */
    copy: string;
    /** The output's name, as a region the keyboard reaches while it scrolls. */
    output: string;
    /** TerminalTitle's words when it is given none. */
    title: string;
  };
  testResults: {
    /** A run's or a test's duration, from milliseconds ("120ms", "1.20s"). */
    duration: (milliseconds: number) => string;
    /** TestResultsProgress's label: how many passed of how many ("12 of 14 tests passed"). */
    progress: (passed: number, total: number) => string;
    /** TestResultsSummary's words: the run's counts ("Ran 14 tests, 2 failed, 1 skipped"). */
    ran: (total: number, failed: number, skipped: number) => string;
    /** A skipped test's name, so its status is in words ("Skipped deletes a user"). */
    skipped: (name: string) => string;
    /** TestSuiteStats's words: a suite's counts ("3 passed, 1 failed"). */
    stats: (passed: number, failed: number, skipped: number) => string;
  };
  themeToggle: {
    dark: { name: string; line: string };
    icon: (label: string, current: string, next: string) => string;
    /** Its name. */
    label: string;
    light: { name: string; line: string };
    noMode: (mode: string, modes: string[]) => string;
    noTheme: (theme: string, known: string[]) => string;
    system: { name: string; line: string };
    /** The name of the group of themes, under the modes. */
    themes: string;
  };
  toast: {
    /** The name of the close button on a toast that stays. */
    close: string;
    /** What a toast's action says when its work failed. The toast stays. */
    error: string;
    /** What a screen reader hears once an action has been working for a second. */
    loading: string;
    /** The region's name, for a screen reader. */
    name: string;
  };
  tool: {
    /** The output's name in its place when the call failed. */
    error: string;
    input: string;
    output: string;
    /** Where the call stands, in its Badge after the title, by the AI SDK's tool state. */
    states: {
      "input-streaming": string;
      "input-available": string;
      "approval-requested": string;
      "approval-responded": string;
      "output-available": string;
      "output-error": string;
      "output-denied": string;
    };
  };
  trace: {
    /** A line's status, said after its words to a screen reader: the mark and the colour say it to the eye. */
    states: {
      running: string;
      error: string;
      pending: string;
    };
  };
  treeView: {
    /** Clears the filter field. */
    clear: string;
    /** Shown in the tree's place when the filter matches nothing. */
    empty: string;
    /** The filter field's name and its placeholder. */
    filter: string;
  };
}

const english: I18nCatalog = {
  action: {
    agentAsks: "Does something that needs your yes",
    agentPresses: (words: string) => `Presses "${words}"`,
    error: "Could not finish",
    loading: "Working",
    success: "Done",
  },
  alert: {
    close: "Dismiss",
  },
  alertDialog: {
    cancel: "Cancel",
  },
  attachment: {
    remove: (name) => `Remove ${name}`,
  },
  audioPlayer: {
    back: "Back 10 seconds",
    error: "Could not play this file",
    forward: "Forward 10 seconds",
    loading: "Loading the sound",
    pause: "Pause",
    play: "Play",
    playbackRate: "Speed",
    position: "Position",
    soundOn: "Turn sound on",
    soundOff: "Turn sound off",
    timeOf: (now, length) => `${spokenTime(now)} of ${spokenTime(length)}`,
  },
  avatar: {
    groupCount: (count) => `+${count}`,
    groupName: (shown, rest) => {
      if (rest > 0) {
        return `${shown.join(", ")} and ${rest === 1 ? "1 other" : `${rest} others`}`;
      }
      if (shown.length < 2) {
        return shown.join("");
      }
      return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1) ?? ""}`;
    },
  },
  badge: {
    dot: {
      default: "Note",
      success: "Done",
      warning: "Warning",
      destructive: "Error",
      info: "Info",
    },
    remove: "Remove",
    removeNamed: (words: string) => `Remove ${words}`,
  },
  breadcrumb: {
    ellipsis: "Show hidden levels",
    name: "Breadcrumb",
  },
  calendar: {
    next: "Next month",
    previous: "Previous month",
  },
  carousel: {
    carousel: "carousel",
    next: "Next",
    page: (page) => `Page ${page}`,
    pages: (label) => `Pages of ${label}`,
    previous: "Previous",
    slide: "slide",
    slideLabel: (slide, count) => `${slide} of ${count}`,
  },
  chainOfThought: {
    name: "Steps",
  },
  chart: {
    described: (label, summary) => `${label}. ${summary}`,
    flow: (source, target) => `${source} → ${target}`,
    flowLabel: ({ source, target, value, share }) =>
      `${source} to ${target}: ${value}, ${share}`,
    part: (name, value, share) => `${name}: ${value}, ${share}`,
    partShare: (name, share) => `${name} · ${share}`,
    point: (name, value) => `${name}: ${value}`,
    pointAt: (label, points) => [label, ...points].join(", "),
    shareOf: (share, source) => `${share} of ${source}`,
    step: (name, value) => (name === "" ? value : `${name} ${value}`),
  },
  codeBlock: {
    collapse: "Show less",
    expand: "Show more",
    moreLines: (count: number) =>
      count === 1 ? "1 more line" : `${count} more lines`,
    plainText: "Text",
    streaming: "Writing",
  },
  combobox: {
    empty: "No results",
    notChoice: (value: string) => `${value} is not one of the choices`,
    trigger: "Show the choices",
  },
  command: {
    dialogPlaceholder: "Type a command or search",
    dialogTrigger: "Search",
    empty: "No results",
    error: "Failed",
    expand: (label: string) => `More for ${label}`,
    loading: "Searching",
    moreHint: "Right arrow for more",
    placeholder: "Search",
  },
  confirmation: {
    approved: "Approved",
    declined: "Declined",
    failed: "Failed",
  },
  context: {
    title: "Context",
    progress: "Context used",
    trigger: (percent) => `${percent} context`,
    used: (used, max) => `${used} / ${max}`,
    totalCost: "Total cost",
    kinds: {
      input: "Input",
      output: "Output",
      reasoning: "Reasoning",
      cache: "Cache",
    },
  },
  messageScroller: {
    arrived: (count: number) =>
      count === 1 ? "1 new message" : `${count} new messages`,
    jumpToNew: (jumpLabel: string) => `${jumpLabel}, new messages`,
    label: "Messages",
    loading: "Loading the conversation",
    scrollToEnd: "Jump to latest",
    scrollToStart: "Jump to start",
  },
  copyButton: {
    copied: "Copied",
    copy: "Copy",
    copyError: "Not copied",
  },
  dataGrid: {
    cell: (column, row) => `${column}, row ${String(row)}`,
    cleared: "Cleared",
    copied: "Copied",
    cut: "Cut",
    edit: (cell) => `Edit ${cell}`,
    invalid: (column, kind) => `${column} takes ${kind}`,
    pasted: "Pasted",
    readOnly: "Read only",
    redone: "Redone",
    row: "Row",
    selected: (count, from, to, top, bottom) =>
      `${String(count)} cells chosen: ${from} to ${to}, rows ${String(top)} to ${String(bottom)}`,
    takes: { figure: "a figure", option: "one of its options" },
    ticked: "Ticked",
    undone: "Undone",
    unticked: "Not ticked",
    width: (header) => `Width of ${header}`,
  },
  dataTable: {
    actions: "Actions",
    actionsFor: (name) => `Actions for ${name}`,
    cancel: "Cancel",
    chooseAll: (one) => `Choose every ${one} shown`,
    chooseColumn: "Choose",
    clear: "Clear",
    clearSearch: "Clear search",
    close: (name) => `Close ${name}`,
    columnInfo: (header) => `More about ${header}`,
    columnMenu: (header) => `Column: ${header}`,
    columns: "Columns",
    confirm: (action, count, unit) => `${action} ${count} ${unit}?`,
    confirmDetail: "This cannot be undone.",
    done: (action, count, unit) => `${action}: ${count} ${unit}`,
    error: (many) => `The ${many} did not load`,
    exportCsv: "Export CSV",
    failedDetail: "Check the connection, then try again.",
    filterAtLeast: "is at least",
    filterAtMost: "is at most",
    filterContains: "contains",
    filterField: "Field",
    filterIs: "is",
    filterIsNot: "is not",
    filterLabel: (label) => `Filter ${label.toLowerCase()}`,
    filterLacks: "does not contain",
    filterName: "Filter condition",
    filterOperator: "Operator",
    filterSegments: {
      field: "Filter field",
      operator: "Filter operator",
      value: "Filter value",
    },
    filterValue: "Value",
    groupAttention: "needs attention",
    hide: "Hide column",
    loading: (many) => `Loading ${many}`,
    loadingMore: (many) => `Loading more ${many}`,
    moveEarlier: "Move earlier",
    moveLater: "Move later",
    noDate: "No date",
    noMatch: (many, query) => `No ${many} match “${query}”.`,
    noneMeet: (many) => `No ${many} meet the filter.`,
    noneYet: (many) => `No ${many} yet.`,
    open: (name) => `Open ${name}`,
    pages: (label) => `Pages of ${label.toLowerCase()}`,
    pinEnd: "Pin to the end",
    pinStart: "Pin to the start",
    rowPending: "pending",
    rowRemoved: "removed",
    search: (many) => `Search ${many}`,
    searchLabel: (label) => `Search ${label.toLowerCase()}`,
    select: (name) => `Choose ${name}`,
    selected: (count, total) => `${count} of ${total} chosen`,
    sortDown: "Sort high to low",
    sortNext: "Sort by this next",
    sortUp: "Sort low to high",
    tryAgain: "Try again",
    undo: "Undo",
    unpin: "Unpin",
    view: "View",
    width: (header) => `Width of ${header}`,
    withChosen: (many) => `With the chosen ${many}`,
    unit: { one: "row", other: "rows" },
  },
  datePicker: {
    last30: "Last 30 days",
    last7: "Last 7 days",
    presets: "Presets",
    rangeEnd: (field: string) => `${field}, end`,
    rangeStart: (field: string) => `${field}, start`,
    rangeTrigger: "Choose date",
    select: "Choose date",
    triggerWith: (trigger: string, chosen: string) => `${trigger}, ${chosen}`,
    thisMonth: "This month",
    today: "Today",
  },
  dialog: {
    close: "Close",
  },
  diffViewer: {
    accept: "Accept",
    accepted: "Accepted",
    added: "Added",
    after: "After",
    before: "Before",
    change: "Change",
    changeOf: (at, of, removed, added) =>
      `Change ${at} of ${of}: ${sizesOf(removed, added)}`,
    counts: (added, removed) =>
      `${added === 0 ? "No" : added} ${added === 1 ? "line" : "lines"} added, ${removed === 0 ? "none" : removed} removed`,
    filesAdded: "Added",
    filesDeleted: "Deleted",
    filesFilesChanged: (files) => {
      if (files === 0) {
        return "No files changed";
      }
      return `${files} ${files === 1 ? "file" : "files"} changed`;
    },
    filesModified: "Modified",
    filesNothing: "No files changed.",
    hunk: (oldStart, oldCount, newStart, newCount) => {
      const before = englishLines(oldStart, oldCount);
      return `${before.charAt(0).toUpperCase()}${before.slice(1)} before, ${englishLines(newStart, newCount)} after`;
    },
    lineAfter: "Line after",
    lineBefore: "Line before",
    lines: (name) => `${name}, lines`,
    name: "Changes",
    filesName: "Changed files",
    nothing: "Nothing changed.",
    reject: "Reject",
    rejected: "Rejected",
    removed: "Removed",
    said: (at, decision) =>
      decision === null
        ? `Change ${at} back to undecided`
        : `Change ${at} ${decision}`,
    same: "Nothing changed: both are the same.",
    text: "Text",
    unchanged: (count) => `Show ${count} unchanged lines`,
    undo: "Undo",
  },
  drawer: {
    handle: "Resize",
  },
  dropdownMenu: {
    expand: "More actions",
  },
  empty: {
    error: "This did not load",
  },
  field: {
    statusError: "Could not save. Your choice is kept.",
    statusLoading: "Saving",
    statusRetry: "Try again",
    statusSuccess: "Saved",
  },
  fileUpload: {
    added: (count) => (count === 1 ? "1 file added" : `${count} files added`),
    doneLine: (size) => `${size}, uploaded`,
    drop: "Drop files here, or",
    error: "Could not upload",
    files: "Files",
    limits: (types, maxSize) => {
      const kinds = orList(types.map(fileType));
      if (maxSize === undefined) {
        return kinds;
      }
      return kinds === "" ? `Up to ${maxSize}` : `${kinds}, up to ${maxSize}`;
    },
    notSent: (name) => `Could not upload ${name}.`,
    refused: (name, reason) =>
      ({
        "file-type": `${name} is not a kind of file this takes.`,
        "file-too-large": `${name} is too large.`,
        "file-too-small": `${name} is empty.`,
        "too-many-files": `${name} is one file too many.`,
      })[reason] ?? `${name}: ${reason}`,
    remove: (name) => `Remove ${name}`,
    removed: (names) =>
      names.length === 1
        ? `${names[0] ?? ""} removed`
        : `${names.length} files removed`,
    retry: "Try again",
    select: "Choose files",
    sent: (name) => `${name} uploaded.`,
    uploading: (percent) => `Uploading, ${percent}%`,
    uploadingName: (name) => `Uploading ${name}`,
  },
  holdButton: {
    ask: (words: string) => `${words}?`,
    cancel: "Cancel",
    confirm: "Confirm",
    holdTo: (words: string) =>
      `Hold to ${words.charAt(0).toLowerCase()}${words.slice(1)}`,
  },
  imageUpload: {
    add: "Add a picture",
    change: "Change picture",
    error: "Could not save",
    how: "Click or drop a picture.",
    refused: (name, reason) =>
      ({
        "file-type": `${name} is not a kind of picture this takes.`,
        "file-too-large": `${name} is too large.`,
        "file-too-small": `${name} is empty.`,
      })[reason] ?? `${name}: ${reason}`,
    refusedInRow: (reason) =>
      ({
        "file-type": "Not a kind of picture this takes.",
        "file-too-large": "Too large.",
        "file-too-small": "That file is empty.",
      })[reason] ?? reason,
    remove: "Remove picture",
    retry: "Try again",
    retryTip: "Could not save. Try again?",
    saved: "Saved",
    saving: "Saving",
  },
  inlineCitation: {
    trigger: (host, more) => (more > 0 ? `${host} +${more}` : host),
    unknown: "Source",
    sources: "Sources",
    index: (current, count) => `${current}/${count}`,
  },
  inlineEdit: {
    edit: "Edit",
    error: "Could not save",
    saved: (value: string) => `Changed to ${value}`,
  },
  input: {
    hidePassword: "Hide password",
    replace: "Replace",
    showPassword: "Show password",
  },
  keyValue: {
    copy: (label) => `Copy ${label.toLocaleLowerCase()}`,
    loading: "Loading the value",
  },
  link: {
    external: "opens in a new tab",
  },
  markdown: {
    back: (number: number) => `Back to reference ${number}`,
    done: "Done",
    footnote: (number: number) => `Footnote ${number}`,
    notDone: "Not done",
    table: "Table",
  },
  menu: {
    error: "Failed",
    loading: "Working",
  },
  message: {
    actions: "Message actions",
    assistant: "Assistant",
    done: "Answer ready",
    error: "Could not answer",
    retry: "Try again",
    stopped: "Stopped",
    streaming: "Writing",
    user: "You",
  },
  modelSelector: {
    empty: "No models found",
    search: "Search models",
    trigger: "Model",
    triggerWith: (trigger: string, model: string) => `${trigger}: ${model}`,
    makers: "Makers",
    favorites: "Favourites",
    noFavorites: "No favourites yet",
    effort: "Thinking",
    addFavorite: (model: string) => `Add ${model} to favourites`,
    removeFavorite: (model: string) => `Remove ${model} from favourites`,
    added: (model: string) => `${model} added to favourites`,
    removed: (model: string) => `${model} removed from favourites`,
    chosen: (model: string) => `${model} chosen`,
    favoriteKeys:
      "At the end of the search, the arrow toward the line's end stars or unstars the highlighted model",
  },
  numberField: {
    decrement: "Decrease",
    increment: "Increase",
  },
  pagination: {
    loading: "Loading the page",
    name: "Pagination",
    next: "Next page",
    none: (unit: string) => `No ${unit}`,
    page: (current: string, count: string) => `Page ${current} of ${count}`,
    previous: "Previous page",
    range: (first: string, last: string, total: string, unit: string) =>
      `Showing ${first} – ${last} of ${total} ${unit}`,
    unit: { one: "item", other: "items" },
  },
  promptInput: {
    add: "Add to message",
    addAttachments: "Add files",
    attachments: "Files to send",
    count: (length: number, max: number) => `${length}/${max}`,
    cut: (max: number) =>
      max === 0
        ? "What was added was left out: no more can be written"
        : `What was added was cut at the limit of ${englishCharacters(max)}`,
    drop: "Drop to add",
    failed: "Could not send. Your message is kept.",
    mentionEmpty: "No matches",
    mentionsError: "Could not load suggestions",
    mentionsFound: (count: number) =>
      count === 0
        ? "No results"
        : `${count} ${count === 1 ? "result" : "results"}`,
    mentionsLoading: "Looking",
    near: (max: number) =>
      max === 0
        ? "No room left"
        : `Close to the limit of ${englishCharacters(max)}`,
    reached: (max: number) =>
      max === 0
        ? "No more can be written"
        : `The limit of ${englishCharacters(max)} is reached`,
    speechButton: {
      cancel: "Cancel dictation",
      done: "Done",
      label: "Dictate",
      listening: "Listening",
      mute: "Mute",
      settling: "Writing it down",
    },
    stop: "Stop",
    submit: "Send",
    succeeded: "Done",
    voice: {
      close: "Close voice",
      label: "Voice conversation",
      listening: "Listening",
      speaking: "Speaking",
    },
  },
  questionnaire: {
    error: "Could not send the answer",
    next: "Next",
    other: "Other",
    previous: "Previous",
    progress: (current, total) => `Question ${current} of ${total}`,
    progressLabel: "Progress",
    step: (current, total) => `${current} of ${total}`,
    recommended: "Recommended",
    required: "Answer this question to go on",
    skip: "Skip",
    submit: "Send answer",
  },
  reasoning: {
    done: "Thought",
    thinking: "Thinking",
    thought: (seconds: number) =>
      `Thought for ${seconds} ${seconds === 1 ? "second" : "seconds"}`,
  },
  sheet: {
    close: "Close",
  },
  sidePanel: {
    close: "Close",
    showAll: "Show all",
    views: "Views",
  },
  sidebar: {
    main: "Main",
    name: "Sidebar",
    toggle: "Show or hide the sidebar",
  },
  sources: {
    count: (count) =>
      count === 0
        ? "No sources"
        : `${count} ${count === 1 ? "source" : "sources"}`,
    gone: "Could not be opened",
    heading: "Sources",
    locked: "You cannot open this",
    newTab: "(opens in a new tab)",
  },
  stackTrace: {
    copy: "Copy the stack trace",
    error: "Error",
    frames: "Stack frames",
    noFrames: "No stack frames",
  },
  stepper: {
    count: (step: number, total: number) => `Step ${step} of ${total}`,
    current: (step: number, total: number, label: string) =>
      `Step ${step} of ${total}: ${label}`,
    finished: "All steps done",
    navBack: "Back",
    navNext: "Next",
    states: {
      complete: "done",
      active: "current step",
      pending: "not started",
      error: "failed",
    },
  },
  suggestion: {
    name: "Suggestions",
  },
  switch: {
    error: "Could not save",
  },
  table: {
    sortIndex: (place) => `sorted ${places[place - 1] ?? `${place}th`}`,
  },
  tableOfContents: {
    collapsed: (label) => `${label}, folded`,
    open: (title) => `${title}: Show the sections`,
    title: "On this page",
  },
  tabs: {
    close: (name: string) => `Close ${name}`,
  },
  tagsInput: {
    duplicate: (word) => `"${word}" is already added.`,
    empty: "Press Enter to add it.",
    full: (most) => `Up to ${most}.`,
    invalid: "not valid",
  },
  terminal: {
    clear: "Clear the output",
    cleared: "Output cleared",
    copy: "Copy the output",
    output: "Terminal output",
    title: "Terminal",
  },
  testResults: {
    duration: (milliseconds) =>
      milliseconds < 1000
        ? `${Math.round(milliseconds)}ms`
        : `${(milliseconds / 1000).toFixed(2)}s`,
    progress: (passed, total) =>
      `${passed} of ${total} ${total === 1 ? "test" : "tests"} passed`,
    ran: (total, failed, skipped) =>
      [
        `Ran ${total} ${total === 1 ? "test" : "tests"}`,
        failed > 0 ? `${failed} failed` : "",
        skipped > 0 ? `${skipped} skipped` : "",
      ]
        .filter((part) => part !== "")
        .join(", "),
    skipped: (name) => `Skipped ${name}`,
    stats: (passed, failed, skipped) =>
      [
        passed > 0 ? `${passed} passed` : "",
        failed > 0 ? `${failed} failed` : "",
        skipped > 0 ? `${skipped} skipped` : "",
      ]
        .filter((part) => part !== "")
        .join(", "),
  },
  themeToggle: {
    dark: { name: "Dark", line: "Always dark" },
    icon: (label, current, next) => `${label}, ${current}. Switch to ${next}`,
    label: "Theme",
    light: { name: "Light", line: "Always light" },
    noMode: (mode: string, modes: string[]) =>
      `No mode "${mode}" in Theme. Its modes: ${modes.join(", ")}.`,
    noTheme: (theme: string, known: string[]) =>
      `No theme "${theme}" in Theme. Its themes: ${known.join(", ")}.`,
    system: { name: "System", line: "As your device" },
    themes: "Colours",
  },
  toast: {
    close: "Close",
    error: "Could not finish",
    loading: "Still working",
    name: "Notifications",
  },
  tool: {
    error: "Error",
    input: "Input",
    output: "Output",
    states: {
      "input-streaming": "Pending",
      "input-available": "Running",
      "approval-requested": "Awaiting approval",
      "approval-responded": "Responded",
      "output-available": "Completed",
      "output-error": "Error",
      "output-denied": "Denied",
    },
  },
  trace: {
    states: {
      running: "Working",
      error: "Failed",
      pending: "Waiting",
    },
  },
  treeView: {
    clear: "Clear the filter",
    empty: "No matches",
    filter: "Filter",
  },
};

const CatalogContext = createContext<I18nCatalog>(english);
const LocaleContext = createContext<string | undefined>(undefined);

const isWords = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Whether two catalogues say the same: the same parts and the same strings. A word that is a
 * function is taken as the same: one built while rendering is a new function every time, and it
 * is read again whenever the language or a string changes.
 */
const sameWords = (one: unknown, other: unknown): boolean => {
  if (one === other) {
    return true;
  }
  if (typeof one === "function" && typeof other === "function") {
    return true;
  }
  if (!(isWords(one) && isWords(other))) {
    return false;
  }
  const keys = Object.keys(one);
  return (
    keys.length === Object.keys(other).length &&
    keys.every((key) => sameWords(one[key], other[key]))
  );
};

/** Every part's words: the catalogue's for each part it gives, English for the rest. */
const wordsOf = (catalog: Partial<I18nCatalog> | undefined): I18nCatalog =>
  catalog === undefined ? english : { ...english, ...catalog };

export interface I18nProviderProps {
  /**
   * The words in the page's language, by part. A part left out keeps its English; a part given
   * gives every word of it. A constant per language, or an object built while rendering from a
   * translation library: the provider keeps the words it has until `locale` or one of the
   * strings changes, and reads the function words again then.
   */
  catalog?: Partial<I18nCatalog>;
  /**
   * The page's language, as a BCP 47 tag ("nl-NL"): numbers and dates are formatted in it, and the
   * catalogue is read again whenever it changes. Always given, so words never outlive their
   * language.
   */
  locale: string;
  children: ReactNode;
}

/** The words of every component inside it, in one language. Once per React root. */
export const I18nProvider = ({
  catalog,
  locale,
  children,
}: I18nProviderProps) => {
  // The words as last read, so a catalogue built again with the same words is the same object to
  // everything that reads it.
  const [read, setRead] = useState(() => ({
    catalog,
    locale,
    words: wordsOf(catalog),
  }));
  let { words } = read;
  if (read.locale !== locale || !sameWords(read.catalog, catalog)) {
    words = wordsOf(catalog);
    setRead({ catalog, locale, words });
  }
  return (
    <LocaleContext value={locale}>
      <CatalogContext value={words}>{children}</CatalogContext>
    </LocaleContext>
  );
};

/** Every component's words: the provider's for each part it gives, English for the rest. */
export const useI18n = (): I18nCatalog => use(CatalogContext);

/** The page's language for numbers and dates: the provider's, else undefined (the browser's). */
export const useLocale = (): string | undefined => use(LocaleContext);
