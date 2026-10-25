import { WebVTTParser } from "webvtt-parser";
import type { WebVTTCue, WebVTTNode } from "webvtt-parser";
import entities from "webvtt-parser/html-entities.json";

import { TooLargeError } from "./too-large.ts";

// A WebVTT file (W3C's captions format, as meeting tools export a
// recording's transcript) as a transcript and the Markdown its document
// holds. Parsed by W3C's own parser (webvtt.js), only inside the
// extractor's sandbox (worker.ts). Each cue's voice (`<v Anna>`) is its
// speaker, and cues one after another in the same voice are one turn,
// from the first one's start to the last one's end. Markup is dropped: a
// turn is the cue's words. Captions carry no chapters.

/** A turn as the Brain keeps it (packages/brain transcripts.ts). */
export interface VttTurn {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

/** A WebVTT file's transcript, and its text as the document holds it. */
export interface VttExtraction {
  markdown: string;
  transcript: { turns: VttTurn[]; chapters: [] };
}

/** Most turns one transcript has: the Brain's limit. */
const maxTurns = 5000;

/** Longest turn, in characters: the Brain's limit, with room to spare. */
const maxTurnLength = 10_000;

/** Turns a section of the document holds: so search finds a passage, not the whole file. */
const turnsPerSection = 50;

const msPerSecond = 1000;
const secondsPerMinute = 60;

const whitespace = /\s+/gu;
const wikiLink = /\[\[/gu;

/** A cue's words, without markup: ruby annotations (`<rt>`) left out. */
const wordsOf = (nodes: readonly WebVTTNode[]): string =>
  nodes
    .map((node) => {
      if (node.type === "text") {
        return node.value;
      }
      if (node.type === "object" && node.name !== "rt") {
        return wordsOf(node.children);
      }
      return "";
    })
    .join("");

/** The first voice a cue names, or empty for none. */
const voiceOf = (nodes: readonly WebVTTNode[]): string => {
  for (const node of nodes) {
    if (node.type === "object") {
      if (node.name === "v") {
        return (node.value ?? "").replaceAll(whitespace, " ").trim();
      }
      const inner = voiceOf(node.children);
      if (inner !== "") {
        return inner;
      }
    }
  }
  return "";
};

/** Where in the recording, as people read it: minutes and seconds. */
const placeOf = (ms: number): string => {
  const seconds = Math.floor(ms / msPerSecond);
  const minutes = Math.floor(seconds / secondsPerMinute);
  return `${minutes}:${String(seconds % secondsPerMinute).padStart(2, "0")}`;
};

/** A cue's turn: its voice, its words on one line, and its times. */
const turnOf = (cue: WebVTTCue): VttTurn => ({
  speaker: voiceOf(cue.tree.children),
  text: wordsOf(cue.tree.children).replaceAll(whitespace, " ").trim(),
  startMs: Math.round(cue.startTime * msPerSecond),
  endMs: Math.round(cue.endTime * msPerSecond),
});

/**
 * One line of the document per turn: who, when and what. No line starts
 * a heading, and `[[` names no document.
 */
const lineOf = ({ speaker, text, startMs }: VttTurn): string => {
  const said = `(${placeOf(startMs)}) ${text}`.replaceAll(wikiLink, "[\\[");
  return speaker === ""
    ? said
    : `${speaker.replaceAll(wikiLink, "[\\[")} ${said}`;
};

/** A WebVTT file's transcript and Markdown. Throws for a file that isn't one. */
export const vttExtraction = (bytes: Uint8Array): VttExtraction => {
  // WebVTT is UTF-8 (the spec's decoder), with any byte order mark kept
  // for the parser, which reads it before the signature.
  const input = new TextDecoder("utf-8", {
    fatal: false,
    ignoreBOM: true,
  }).decode(bytes);
  // Every character reference HTML names, as the spec reads them: without
  // the table, the parser knows a few and leaves `&amp;` as `&;`.
  const { cues, errors } = new WebVTTParser(entities).parse(input);
  if (errors.some(({ line }) => line === 1)) {
    throw new Error("Not a WebVTT file: no signature");
  }
  const turns: VttTurn[] = [];
  for (const cue of cues) {
    const turn = turnOf(cue);
    const last = turns.at(-1);
    if (turn.text === "") {
      continue;
    }
    if (
      last !== undefined &&
      last.speaker === turn.speaker &&
      last.text.length + turn.text.length < maxTurnLength
    ) {
      last.text = `${last.text} ${turn.text}`;
      last.endMs = Math.max(last.endMs, turn.endMs);
    } else {
      turns.push({
        ...turn,
        text: turn.text.slice(0, maxTurnLength),
      });
    }
    if (turns.length > maxTurns) {
      throw new TooLargeError();
    }
  }
  if (turns.length === 0) {
    return { markdown: "", transcript: { turns, chapters: [] } };
  }
  const sections: string[] = [];
  for (let start = 0; start < turns.length; start += turnsPerSection) {
    const part = turns.slice(start, start + turnsPerSection);
    const [first] = part;
    sections.push(
      `## ${placeOf(first?.startMs ?? 0)}\n\n${part.map(lineOf).join("\n\n")}`
    );
  }
  return {
    markdown: sections.join("\n\n"),
    transcript: { turns, chapters: [] },
  };
};
