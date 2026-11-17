// File upload's and Image well's own words, in English. The product gives them in its languages
// through GraspWords (src/words); a caller's `words` still win until the breaking release's step 5.
// A word with a name or a size in it is a function.
import type { FileUploadWords } from "./file-upload";
import type { ImageWellWords } from "./image-well";

export const fileUploadWords: FileUploadWords = {
  drop: "Drop files here, or",
  choose: "Choose files",
  uploading: "Uploading",
  done: "Uploaded",
  failed: "Could not upload",
  retry: "Try again",
  files: "Files",
  doneLine: (size) => `${size}, uploaded`,
  sent: (name) => `${name} uploaded.`,
  notSent: (name) => `Could not upload ${name}.`,
  remove: (name) => `Remove ${name}`,
  refused: (name, reason) =>
    ({
      "file-type": `${name} is not a kind of file this takes.`,
      "file-too-large": `${name} is too large.`,
      "file-too-small": `${name} is empty.`,
      "too-many-files": `${name} is one file too many.`,
    })[reason] ?? `${name}: ${reason}`,
};

export const imageWellWords: ImageWellWords = {
  change: "Change picture",
  add: "Add a picture",
  remove: "Remove picture",
  saving: "Saving",
  saved: "Saved",
  failed: "Could not save",
  retry: "Try again",
  how: "Click or drop a picture.",
  refused: (name, reason) =>
    ({
      "file-type": `${name} is not a kind of picture this takes.`,
      "file-too-large": `${name} is too large.`,
      "file-too-small": `${name} is empty.`,
    })[reason] ?? `${name}: ${reason}`,
};

declare module "../words/words" {
  interface GraspWordsCatalog {
    fileUpload: FileUploadWords;
    imageWell: ImageWellWords;
  }
}
