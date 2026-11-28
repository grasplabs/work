import { describe, expect, it } from "vite-plus/test";

import { stopIfEnded } from "./test-attempts.ts";

// What a test cut off at its timeout leaves going, as these two tests
// stage it in order: the first starts work it doesn't wait for, as a
// timed-out test doesn't, and the next lets that work go on.
const goOn = Promise.withResolvers<null>();
let leftGoing: Promise<string> = Promise.resolve("never started");

describe("work a test left going", () => {
  it("starts work its test doesn't wait for, which may ask while its test runs", () => {
    leftGoing = (async () => {
      await goOn.promise;
      stopIfEnded();
      return "it went on into the next test";
    })();
    // Read by the next test: no rejection of it goes unheard meanwhile.
    leftGoing.catch(() => null);
    // Its own test, still running, may ask.
    expect(stopIfEnded).not.toThrow();
  });

  it("stops at its next ask of shared state once the test that started it ended", async () => {
    goOn.resolve(null);
    await expect(leftGoing).rejects.toThrow(
      "The test this work belongs to has ended"
    );
  });
});
