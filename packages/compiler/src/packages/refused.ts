/**
 * Why a package's tarball can't be used (tarball.ts): always the first
 * thing found, in words a person reviewing the graph reads.
 */
export class TarballRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TarballRefusedError";
  }
}
