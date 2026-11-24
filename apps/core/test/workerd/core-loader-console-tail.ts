import { WorkerEntrypoint } from "cloudflare:workers";

/** The tail an App's isolate names, as core's `AppTail` is: it keeps nothing. */
export class TestTail extends WorkerEntrypoint {
  // oxlint-disable-next-line eslint/class-methods-use-this -- the runtime calls it
  override tail(): void {
    // The runtime hands the isolate's console over here; nothing to do.
  }
}
