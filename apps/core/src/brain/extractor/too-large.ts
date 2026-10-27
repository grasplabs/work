/** Why a file was refused before reading it all: it holds more than a document. */
export class TooLargeError extends Error {
  constructor() {
    super("The file holds more than a document does");
    this.name = "TooLargeError";
  }
}
