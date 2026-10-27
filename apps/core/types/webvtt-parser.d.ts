// The part of webvtt-parser (W3C's webvtt.js) the extractor uses
// (src/brain/extractor/vtt.ts): the package ships no types.
declare module "webvtt-parser" {
  /** A node of a cue's text: text, or a tag (`v` with its voice as `value`). */
  export type WebVTTNode =
    | { type: "text"; value: string }
    | { type: "timestamp"; value: number }
    | {
        type: "object";
        name: string;
        classes: string[];
        value?: string;
        children: WebVTTNode[];
      };

  export interface WebVTTCue {
    id: string;
    /** Seconds. */
    startTime: number;
    endTime: number;
    text: string;
    tree: { children: WebVTTNode[] };
  }

  export interface WebVTTParseResult {
    cues: WebVTTCue[];
    errors: { message: string; line: number; col?: number }[];
    time: number;
    styles: string[];
  }

  export class WebVTTParser {
    constructor(entities?: Record<string, string>);
    parse(input: string, mode?: "metadata" | "chapters"): WebVTTParseResult;
  }
}
