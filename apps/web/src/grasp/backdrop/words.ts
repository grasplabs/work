// Backdrop's own words, in English: the picker's (`backdropPicker`) and the preview's
// (`backdropPreview`). The product gives them in its languages through GraspWords (src/words); a
// caller's `words` (the picker), `title`, `placeholder` and `aria-label` (the preview) still win
// until the breaking release's step 5. The preview's little Composer reads the Composer's own
// words (`composer`), so its Send and Stop are the product's too.
import type { BackdropPickerWords } from "./picker";

/** The picker's words. */
export const backdropPickerWords: BackdropPickerWords = {
  names: {
    cliffs: "Cliffs",
    wave: "Wave",
    aurora: "Aurora",
    starry: "Starry night",
    fuji: "Fuji",
    wanderer: "Wanderer",
    dusk: "Dusk",
    dots: "Dots",
    door: "Door",
    sand: "Sand",
    dunes: "Dunes",
    rings: "Rings",
    pixels: "Pixel sand",
    none: "None",
  },
  patterns: { bayer: "Bayer", grid: "Grid", mix: "Bayer grid" },
  tones: {
    light: "Light",
    deep: "Deep",
    mint: "Mint",
    lime: "Lime",
    ink: "Ink",
    rim: "Dark edge",
    core: "Light edge",
    aurora: "Aurora",
  },
  scenes: "Scenes",
  dithers: "Dithers",
  sand: "Sand",
  backdrop: "Backdrop",
  backdropHint: "A scene, a dither, sand, or nothing.",
  pattern: "Pattern",
  patternHint: "How the dither's cells are set.",
  tone: "Colour",
  toneHint: "One green, or a run of greens from the edge in.",
  previewTitle: "What should we look at today?",
  previewLabel: "Preview of your chat backdrop",
  randomize: "Randomize",
};

/** The preview's words: its question, the box's placeholder, and its name for who cannot see it. */
export const backdropPreviewWords = {
  title: "What should we look at today?",
  placeholder: "Ask anything",
  label: "Preview of your chat backdrop",
};

declare module "../words/words" {
  interface GraspWordsCatalog {
    backdropPicker: BackdropPickerWords;
    backdropPreview: typeof backdropPreviewWords;
  }
}
