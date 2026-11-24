import { i18n } from "@lingui/core";
import { afterAll } from "vite-plus/test";

import { trackTimers } from "./test-timers.ts";

// Tests read the page's text in English, as written in the code: no
// catalog, so every message is its own source.
i18n.loadAndActivate({ locale: "en", messages: {} });

// The timers a file starts with the global `setTimeout` are cancelled once
// its last test and hook are done, before the environment takes the page
// away, and none started after that run (each file runs in a process of its
// own). Only `setTimeout`, because that is what Damsko's announcer
// (`announce`, packages/ui/src/lib/utils.ts) waits on: 400 ms between two
// messages. In a happy-dom file that is Node's timer, which outlives the
// page, and a wait that ended after the file's last test found the page
// gone and threw `document is not defined`, failing a run whose tests all
// passed. Not after each test: the announcer's queue lasts the whole file,
// and a wait cut short between two tests would leave it waiting for ever.
// Fake timers replace these while a test uses them. Remove this once
// `announce` checks for the page itself (Damsko is adding that check).
afterAll(trackTimers(globalThis));
