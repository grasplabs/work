// Carousel's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `labels` still win until the breaking release's step 5.
import type { CarouselLabels } from "./carousel";

/** Its words in English: replace any of them through `labels`. */
export const carouselWords: CarouselLabels = {
  previous: "Previous",
  next: "Next",
  pages: (label) => `Pages of ${label}`,
  page: (page) => `Page ${page}`,
};

declare module "../words/words" {
  interface GraspWordsCatalog {
    carousel: CarouselLabels;
  }
}
