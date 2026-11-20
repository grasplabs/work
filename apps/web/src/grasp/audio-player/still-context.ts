// For the docs' every-state row only: an audio player drawn standing still, in a state the docs
// set (playing, a position, muted, a speed, failed) instead of what its file is doing. The shipped
// index does not export it.
import { createContext, useContext } from "react";

/** The state a still player shows. */
export interface AudioStill {
  /** Shown playing: Pause in place of Play. */
  playing?: boolean;
  /** Where it stands, in seconds. */
  time?: number;
  /** The file's length, in seconds. */
  duration?: number;
  /** Shown with the sound off. */
  muted?: boolean;
  /** The speed shown on the speed button. */
  speed?: number;
  /** Shown as a file that could not play. */
  failed?: boolean;
  /** Shown waiting for the file: the play button loading. */
  buffering?: boolean;
}

export const StillContext = createContext<AudioStill | null>(null);

export const useStill = () => useContext(StillContext);
