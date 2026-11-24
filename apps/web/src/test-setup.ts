import { i18n } from "@lingui/core";
import { afterAll } from "vite-plus/test";

// Tests read the page's text in English, as written in the code: no
// catalog, so every message is its own source.
i18n.loadAndActivate({ locale: "en", messages: {} });

// A page's timers end with the page, as in a browser. In a happy-dom file
// the global `setTimeout` is Node's, which outlives the page: Damsko's
// announcer (`announce`, packages/ui/src/lib/utils.ts) waits 400 ms between
// two messages, and a wait that ended after the file's last test found the
// page gone and threw `document is not defined`, failing a run whose tests
// all passed. So the timers a file starts are kept, and once its last test
// and hook are done, before the environment takes the page away, those
// still waiting are cancelled and none start again (each file runs in a
// process of its own). Not after each test: the announcer's queue lasts the
// whole file, and a wait cut short between two tests would leave it
// waiting for ever. Fake timers replace these while a test uses them.
const { setTimeout: start, clearTimeout: stop } = globalThis;
const waiting = new Set<ReturnType<typeof start>>();
let closing = false;
Object.assign(globalThis, {
  setTimeout: (
    run: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    const timer = start(() => {
      waiting.delete(timer);
      run(...args);
    }, ms);
    if (closing) {
      stop(timer);
    } else {
      waiting.add(timer);
    }
    return timer;
  },
  clearTimeout: (timer?: ReturnType<typeof start>) => {
    if (timer !== undefined) {
      waiting.delete(timer);
    }
    stop(timer);
  },
});
afterAll(() => {
  closing = true;
  for (const timer of waiting) {
    stop(timer);
  }
  waiting.clear();
});
