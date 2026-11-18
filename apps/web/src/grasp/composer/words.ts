// The Composer's own words, in English, for every part in this folder. The product gives them in
// its languages through GraspWords (src/words): one `composer` entry, grouped by part. A text prop a
// caller passes still wins, until the breaking release's step 5 removes it.
import { useWords } from "../words/words";
import type { ComposerAttachmentWords } from "./attachment";
import type { ComposerVoiceWords } from "./voice";

/** A file's size as people read it, from its bytes ("820 KB", "1.4 MB"). */
const englishSize = (bytes: number) => {
  if (bytes === 0) {
    return "Empty";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};

/** A count of characters, with its plural ("1 character", "120 characters"). */
const englishCharacters = (count: number) =>
  count === 0
    ? "no characters"
    : `${count} ${count === 1 ? "character" : "characters"}`;

const englishAttachmentWords: ComposerAttachmentWords = {
  uploading: "Uploading",
  done: "Uploaded",
  failed: "Could not upload",
  retry: "Try again",
  remove: "Remove",
  size: englishSize,
  pages: (count) =>
    count === 0 ? "No pages" : `${count} ${count === 1 ? "page" : "pages"}`,
};

const englishVoiceWords: ComposerVoiceWords = {
  asking: "Asking for the microphone",
  listening: "Listening",
  thinking: "Writing it down",
  silent: "Paused",
  muted: "Muted",
  done: "Done",
  cancel: "Cancel",
  mute: "Mute",
  unmute: "Unmute",
  retry: "Try again",
  level: "Level",
  problems: {
    blocked:
      "The microphone is blocked for this site. Allow it in the browser's settings.",
    missing: "No microphone was found.",
    unsupported: "This browser can't dictate.",
    unheard: "A part couldn't be made out. What came before is kept.",
    failed: "The words couldn't be written down. What you typed is kept.",
    limited: "That's as long as one dictation can be.",
  },
  time: (ms) => {
    const seconds = Math.floor(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  },
};

export const composerWords = {
  /** The Composer itself. */
  composer: {
    /** Under the card when a send failed (`failedLabel`). */
    failed: "Could not send",
    /** Said while the assistant works, and shown with `showWorking` (`workingLabel`). */
    working: "Working",
    /** Said when the assistant is done (`successLabel`). */
    success: "Done",
    /** Send's name (`sendLabel`). */
    send: "Send",
    /** Stop's name (`stopLabel`). */
    stop: "Stop",
    /** Over the card while files are dragged onto it (`dropLabel`). */
    drop: "Drop to add",
    /** The microphone's name (`dictateLabel`). */
    dictate: "Dictate",
    /** Under the card while a send waits for uploads (`uploadingLabel`). */
    uploading: "Sending waits for the files to upload",
    /** The strip of files' name (`attachmentsLabel`). */
    attachments: "Files to send",
    /** The menu of commands' name, after `/` (`commandsLabel`). */
    commands: "Commands",
    /** The menu of mentions' name, after `@` (`mentionsLabel`). */
    mentions: "Mention",
    /** In the menu when nothing matches (`mentionsEmptyLabel`). */
    mentionsEmpty: "Nothing found",
    /** In the menu while it looks (`mentionsLoadingLabel`). */
    mentionsLoading: "Looking",
    /** Said with how many the menu found (`mentionsFoundLabel`). */
    mentionsFound: (count: number) =>
      count === 0
        ? "No results"
        : `${count} ${count === 1 ? "result" : "results"}`,
    /** The count near the limit (`maxLengthCountLabel`). */
    count: (length: number, max: number) => `${length}/${max}`,
    /** Said once near the limit (`maxLengthNearLabel`). */
    near: (max: number) =>
      max === 0
        ? "No room left"
        : `Close to the limit of ${englishCharacters(max)}`,
    /** Said once at the limit (`maxLengthReachedLabel`). */
    reached: (max: number) =>
      max === 0
        ? "No more can be written"
        : `The limit of ${englishCharacters(max)} is reached`,
    /** Said when a paste was cut at the limit (`maxLengthCutLabel`). */
    cut: (max: number) =>
      max === 0
        ? "The pasted text was left out: no more can be written"
        : `The pasted text was cut at the limit of ${englishCharacters(max)}`,
  },
  /** ComposerAdd. */
  add: {
    /** The plus' name (`aria-label`). */
    label: "Add to message",
    /** The heading over the actions for this chat (`actionsLabel`). */
    actions: "This chat",
    /** Upload's words (`uploadLabel`). */
    upload: "Upload attachment",
    /** The row that opens the agents, with `agents` (`agentLabel`). */
    agent: "Agent",
  },
  /** ComposerAttachment: a file's words (`words`). */
  attachment: englishAttachmentWords,
  /** ComposerModel. */
  model: {
    /** The control's name (`aria-label`). */
    label: "Model",
    /** The search field's name (`searchLabel`). */
    search: "Search models",
    /** The makers' rail's name (`makersLabel`). */
    makers: "Makers",
    /** The favourites' heading (`favouritesLabel`). */
    favourites: "Favourites",
    /** When nothing matches (`emptyLabel`). */
    empty: "No models found",
  },
  /** ComposerModelEffort. */
  modelEffort: {
    /** The chip's name (`aria-label`). */
    label: "Model and effort",
    /** The model row's name (`modelLabel`). */
    model: "Model",
    /** The effort's heading and the radio group's name (`effortLabel`). */
    effort: "Effort",
    /** For a model with one level (`noEffortLabel`). */
    none: "This model has one level of effort.",
  },
  /** ComposerReasoning: the control's name (`aria-label`). */
  reasoning: {
    label: "Reasoning",
  },
  /** ComposerAgent. */
  agent: {
    /** The control's name, before the chosen agent's own (`aria-label`). */
    label: "Agent",
    /** The search field's name and placeholder, with more than eight agents (`searchLabel`). */
    search: "Search agents",
    /** When nothing matches (`emptyLabel`). */
    empty: "No agents found",
    /** The remove on the chosen agent's chip above the text: back to the default agent, by its name. */
    back: (agent: string) => `Back to ${agent}`,
  },
  /** ComposerQueue. */
  queue: {
    /** Its heading, from how many wait (`queuedLabel`). */
    queued: (count: number) =>
      count === 0 ? "None queued" : `${count} queued`,
    /** Edit's name, for a message (`editLabel`). */
    edit: (text: string) => `Edit: ${text}`,
    /** Send now's name, for a message (`sendNowLabel`). */
    sendNow: (text: string) => `Send now: ${text}`,
    /** Remove's name, for a message (`removeLabel`). */
    remove: (text: string) => `Remove: ${text}`,
  },
  /** ComposerVoice: the dictation's words (`words`). */
  voice: englishVoiceWords,
};

export type ComposerWords = typeof composerWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    composer: ComposerWords;
  }
}

/**
 * One part's group of words: the product's catalogue for it (GraspWords), each key over its English
 * on its own, so a catalogue written before a group gained a key still has it. (The catalogue's own
 * merge goes one level deep, to the groups; this goes into them.)
 */
export const useComposerWords = <G extends keyof ComposerWords>(
  group: G
): ComposerWords[G] => {
  const given: Partial<ComposerWords[G]> = useWords("composer", composerWords)[
    group
  ];
  // Object.assign, as each group's type is its own object, which a generic spread cannot know.
  // oxlint-disable-next-line unicorn/prefer-object-spread, prefer-object-spread -- see above
  return Object.assign({}, composerWords[group], given);
};
