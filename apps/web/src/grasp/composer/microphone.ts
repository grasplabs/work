// useComposerMicrophone: the real microphone for ComposerVoice (voice.tsx), through Web Audio. It
// asks for the microphone when `start` is called (a press, so the browser lets it), and gives a
// `sample` that ComposerVoice reads at each frame: the level (the time-domain RMS, in decibels
// mapped to 0 to 1) and eight log-spaced bands from 120Hz to 7kHz. Nothing is smoothed here: the
// field does its own gate, gain, envelope and spring (voice-motion.ts). Nothing re-renders per
// frame; only `status` is state. It listens only; what is said is the host's speech recognition.
"use client";

import { useEffect, useRef, useState } from "react";

import type { VoiceReading } from "./voice-motion";

/** Where the microphone is: not asked, asking, listening, or why it can't. */
export type ComposerMicrophoneStatus =
  | "idle"
  | "asking"
  | "on"
  | "blocked"
  | "missing"
  | "unsupported";

/** What useComposerMicrophone gives. */
export interface ComposerMicrophone {
  status: ComposerMicrophoneStatus;
  /** Asks for the microphone and starts listening. Call it from a press. */
  start: () => Promise<ComposerMicrophoneStatus>;
  /** Lets the microphone go. */
  stop: () => void;
  /** The sound now, for ComposerVoice's `sample`; undefined while it is not listening. */
  sample: () => VoiceReading | undefined;
}

/** The bands' edges, in Hz: eight, log-spaced from 120Hz to 7kHz. */
const EDGES = Array.from(
  { length: 9 },
  (_, index) => 120 * (7000 / 120) ** (index / 8)
);
/**
 * Decibels to 0 to 1: -72dB (below a quiet room) is 0, -6dB (close and shouting) is 1. Wide, so a
 * loud voice is not clipped flat; the field's auto-gain fills the range for a quiet one.
 */
const QUIET = -72;
const LOUD = -6;
/**
 * Decibels squeeze a voice's syllables close together (a vowel and the dip after it are a few dB
 * apart): expanded again, so the dips read as dips.
 */
const EXPAND = 2.2;

interface Listening {
  context: AudioContext;
  stream: MediaStream;
  analyser: AnalyserNode;
  wave: Float32Array<ArrayBuffer>;
  spectrum: Float32Array<ArrayBuffer>;
  bands: number[];
}

const toUnit = (decibels: number) =>
  Math.min(1, Math.max(0, (decibels - QUIET) / (LOUD - QUIET)));

/** Reads one moment from the analyser. Module-level, so the hook's closure stays small. */
const read = (on: Listening): VoiceReading => {
  on.analyser.getFloatTimeDomainData(on.wave);
  let sum = 0;
  for (const value of on.wave) {
    sum += value * value;
  }
  const rms = Math.sqrt(sum / on.wave.length);
  on.analyser.getFloatFrequencyData(on.spectrum);
  const binHz = on.context.sampleRate / on.analyser.fftSize;
  for (let band = 0; band < 8; band += 1) {
    const from = Math.max(1, Math.floor((EDGES[band] ?? 0) / binHz));
    const to = Math.max(from + 1, Math.ceil((EDGES[band + 1] ?? 0) / binHz));
    let power = 0;
    for (let bin = from; bin < to; bin += 1) {
      power += 10 ** ((on.spectrum[bin] ?? -120) / 10);
    }
    // Higher bands hold less of a voice's energy: lifted a little, so a hiss shows.
    on.bands[band] =
      toUnit(10 * Math.log10(power / (to - from) + 1e-12) + 6 + band * 2) **
      EXPAND;
  }
  return {
    level: toUnit(20 * Math.log10(rms + 1e-9)) ** EXPAND,
    bands: on.bands,
  };
};

/** Asks for the microphone; resolves to what listens, or why it can't. */
const open = async (): Promise<
  Listening | Exclude<ComposerMicrophoneStatus, "idle" | "asking" | "on">
> => {
  if (
    typeof navigator === "undefined" ||
    navigator.mediaDevices?.getUserMedia === undefined ||
    typeof AudioContext === "undefined"
  ) {
    return "unsupported";
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
    });
  } catch (error) {
    return error instanceof DOMException && error.name === "NotFoundError"
      ? "missing"
      : "blocked";
  }
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0;
  context.createMediaStreamSource(stream).connect(analyser);
  return {
    context,
    stream,
    analyser,
    wave: new Float32Array(analyser.fftSize),
    spectrum: new Float32Array(analyser.frequencyBinCount),
    bands: Array.from({ length: 8 }, () => 0),
  };
};

const close = (on: Listening | null) => {
  if (on === null) {
    return;
  }
  for (const track of on.stream.getTracks()) {
    track.stop();
  }
  void on.context.close();
};

/** The microphone, for a ComposerVoice: `start` from a press, `sample` to its `sample` prop. */
export const useComposerMicrophone = (): ComposerMicrophone => {
  const [status, setStatus] = useState<ComposerMicrophoneStatus>("idle");
  const listening = useRef<Listening | null>(null);
  useEffect(
    () => () => {
      close(listening.current);
      listening.current = null;
    },
    []
  );
  return {
    status,
    start: async () => {
      close(listening.current);
      listening.current = null;
      setStatus("asking");
      const opened = await open();
      if (typeof opened === "string") {
        setStatus(opened);
        return opened;
      }
      listening.current = opened;
      setStatus("on");
      return "on";
    },
    stop: () => {
      close(listening.current);
      listening.current = null;
      setStatus("idle");
    },
    sample: () => {
      const on = listening.current;
      return on === null ? undefined : read(on);
    },
  };
};
