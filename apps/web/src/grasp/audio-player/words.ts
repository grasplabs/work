// Audio player's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's text props still win until the breaking release's step 5.
export const audioPlayerWords = {
  /** The words when the file cannot be played, in place of the controls. */
  failed: "Could not play this file",
  /** What the play button says while the file is slow to come. */
  loading: "Loading the sound",
};

export type AudioPlayerOwnWords = typeof audioPlayerWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    audioPlayer: AudioPlayerOwnWords;
  }
}
