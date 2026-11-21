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

// happy-dom rejects a cancelled animation's `finished` even when nobody
// waits on it, which a browser never reports: Grasp UI's Composer cancels
// its listening animation as dictation ends (grasp/composer/voice.tsx).
// Here a cancelled animation's `finished` is left unheard, as there.
if (typeof Element !== "undefined") {
  // oxlint-disable-next-line typescript/unbound-method -- called on its own element below
  const { animate: drawn } = Element.prototype;
  Element.prototype.animate = function animate(
    this: Element,
    ...args: Parameters<Element["animate"]>
  ) {
    const animation = drawn.apply(this, args);
    void (async () => {
      try {
        await animation.finished;
      } catch {
        // Cancelled: nobody was waiting.
      }
    })();
    return animation;
  };
}
