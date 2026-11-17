import { i18n } from "@lingui/core";

// Tests read the page's text in English, as written in the code: no
// catalog, so every message is its own source.
i18n.loadAndActivate({ locale: "en", messages: {} });

// happy-dom has no `document.fonts`, which Grasp UI's page bar listens to
// (grasp/app-shell/bar.tsx) to fit itself again once the fonts load. Here
// no font ever loads: an EventTarget that never fires stands in for it.
if (typeof document !== "undefined" && !("fonts" in document)) {
  Object.defineProperty(document, "fonts", { value: new EventTarget() });
}
