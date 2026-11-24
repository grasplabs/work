import { readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

// Every component and block of Damsko installed in packages/ui, as this app
// imports it: the type check resolves each through the package's exports
// under this app's settings, so a part the exports don't reach, or that
// doesn't type-check here, fails `vp check`. None is loaded: a test is never
// bundled and draws nothing, so none of their CSS reaches the app's
// stylesheet. The test holds the list to what packages/ui holds.

const parts: Record<string, () => Promise<unknown>> = {
  "components/accordion": async () =>
    await import("@grasp-os/ui/components/accordion"),
  "components/agent-indicator": async () =>
    await import("@grasp-os/ui/components/agent-indicator"),
  "components/alert": async () => await import("@grasp-os/ui/components/alert"),
  "components/alert-dialog": async () =>
    await import("@grasp-os/ui/components/alert-dialog"),
  "components/aspect-ratio": async () =>
    await import("@grasp-os/ui/components/aspect-ratio"),
  "components/attachment": async () =>
    await import("@grasp-os/ui/components/attachment"),
  "components/audio-player": async () =>
    await import("@grasp-os/ui/components/audio-player"),
  "components/avatar": async () =>
    await import("@grasp-os/ui/components/avatar"),
  "components/badge": async () => await import("@grasp-os/ui/components/badge"),
  "components/brand-icon": async () =>
    await import("@grasp-os/ui/components/brand-icon"),
  "components/breadcrumb": async () =>
    await import("@grasp-os/ui/components/breadcrumb"),
  "components/bubble": async () =>
    await import("@grasp-os/ui/components/bubble"),
  "components/button": async () =>
    await import("@grasp-os/ui/components/button"),
  "components/button-group": async () =>
    await import("@grasp-os/ui/components/button-group"),
  "components/calendar": async () =>
    await import("@grasp-os/ui/components/calendar"),
  "components/card": async () => await import("@grasp-os/ui/components/card"),
  "components/carousel": async () =>
    await import("@grasp-os/ui/components/carousel"),
  "components/chain-of-thought": async () =>
    await import("@grasp-os/ui/components/chain-of-thought"),
  "components/chart": async () => await import("@grasp-os/ui/components/chart"),
  "components/chat": async () => await import("@grasp-os/ui/components/chat"),
  "components/checkbox": async () =>
    await import("@grasp-os/ui/components/checkbox"),
  "components/code-block": async () =>
    await import("@grasp-os/ui/components/code-block"),
  "components/collapsible": async () =>
    await import("@grasp-os/ui/components/collapsible"),
  "components/combobox": async () =>
    await import("@grasp-os/ui/components/combobox"),
  "components/command": async () =>
    await import("@grasp-os/ui/components/command"),
  "components/confirmation": async () =>
    await import("@grasp-os/ui/components/confirmation"),
  "components/container": async () =>
    await import("@grasp-os/ui/components/container"),
  "components/context": async () =>
    await import("@grasp-os/ui/components/context"),
  "components/context-menu": async () =>
    await import("@grasp-os/ui/components/context-menu"),
  "components/copy-button": async () =>
    await import("@grasp-os/ui/components/copy-button"),
  "components/data-grid": async () =>
    await import("@grasp-os/ui/components/data-grid"),
  "components/data-table": async () =>
    await import("@grasp-os/ui/components/data-table"),
  "components/date-picker": async () =>
    await import("@grasp-os/ui/components/date-picker"),
  "components/dialog": async () =>
    await import("@grasp-os/ui/components/dialog"),
  "components/diff-viewer": async () =>
    await import("@grasp-os/ui/components/diff-viewer"),
  "components/drawer": async () =>
    await import("@grasp-os/ui/components/drawer"),
  "components/dropdown-menu": async () =>
    await import("@grasp-os/ui/components/dropdown-menu"),
  "components/empty": async () => await import("@grasp-os/ui/components/empty"),
  "components/field": async () => await import("@grasp-os/ui/components/field"),
  "components/file-upload": async () =>
    await import("@grasp-os/ui/components/file-upload"),
  "components/form": async () => await import("@grasp-os/ui/components/form"),
  "components/heading": async () =>
    await import("@grasp-os/ui/components/heading"),
  "components/hold-button": async () =>
    await import("@grasp-os/ui/components/hold-button"),
  "components/hover-card": async () =>
    await import("@grasp-os/ui/components/hover-card"),
  "components/icon-tile": async () =>
    await import("@grasp-os/ui/components/icon-tile"),
  "components/image-upload": async () =>
    await import("@grasp-os/ui/components/image-upload"),
  "components/inline-citation": async () =>
    await import("@grasp-os/ui/components/inline-citation"),
  "components/inline-edit": async () =>
    await import("@grasp-os/ui/components/inline-edit"),
  "components/input": async () => await import("@grasp-os/ui/components/input"),
  "components/input-group": async () =>
    await import("@grasp-os/ui/components/input-group"),
  "components/input-otp": async () =>
    await import("@grasp-os/ui/components/input-otp"),
  "components/item": async () => await import("@grasp-os/ui/components/item"),
  "components/kbd": async () => await import("@grasp-os/ui/components/kbd"),
  "components/key-value": async () =>
    await import("@grasp-os/ui/components/key-value"),
  "components/label": async () => await import("@grasp-os/ui/components/label"),
  "components/link": async () => await import("@grasp-os/ui/components/link"),
  "components/markdown": async () =>
    await import("@grasp-os/ui/components/markdown"),
  "components/marker": async () =>
    await import("@grasp-os/ui/components/marker"),
  "components/menubar": async () =>
    await import("@grasp-os/ui/components/menubar"),
  "components/message": async () =>
    await import("@grasp-os/ui/components/message"),
  "components/message-scroller": async () =>
    await import("@grasp-os/ui/components/message-scroller"),
  "components/model-selector": async () =>
    await import("@grasp-os/ui/components/model-selector"),
  "components/navigation-menu": async () =>
    await import("@grasp-os/ui/components/navigation-menu"),
  "components/number-field": async () =>
    await import("@grasp-os/ui/components/number-field"),
  "components/page-header": async () =>
    await import("@grasp-os/ui/components/page-header"),
  "components/pagination": async () =>
    await import("@grasp-os/ui/components/pagination"),
  "components/popover": async () =>
    await import("@grasp-os/ui/components/popover"),
  "components/progress": async () =>
    await import("@grasp-os/ui/components/progress"),
  "components/prompt-input": async () =>
    await import("@grasp-os/ui/components/prompt-input"),
  "components/questionnaire": async () =>
    await import("@grasp-os/ui/components/questionnaire"),
  "components/radio-group": async () =>
    await import("@grasp-os/ui/components/radio-group"),
  "components/reasoning": async () =>
    await import("@grasp-os/ui/components/reasoning"),
  "components/resizable": async () =>
    await import("@grasp-os/ui/components/resizable"),
  "components/scroll-area": async () =>
    await import("@grasp-os/ui/components/scroll-area"),
  "components/section-header": async () =>
    await import("@grasp-os/ui/components/section-header"),
  "components/select": async () =>
    await import("@grasp-os/ui/components/select"),
  "components/separator": async () =>
    await import("@grasp-os/ui/components/separator"),
  "components/sheet": async () => await import("@grasp-os/ui/components/sheet"),
  "components/shimmer": async () =>
    await import("@grasp-os/ui/components/shimmer"),
  "components/side-panel": async () =>
    await import("@grasp-os/ui/components/side-panel"),
  "components/sidebar": async () =>
    await import("@grasp-os/ui/components/sidebar"),
  "components/skeleton": async () =>
    await import("@grasp-os/ui/components/skeleton"),
  "components/slider": async () =>
    await import("@grasp-os/ui/components/slider"),
  "components/snippet": async () =>
    await import("@grasp-os/ui/components/snippet"),
  "components/sources": async () =>
    await import("@grasp-os/ui/components/sources"),
  "components/spinner": async () =>
    await import("@grasp-os/ui/components/spinner"),
  "components/stack-trace": async () =>
    await import("@grasp-os/ui/components/stack-trace"),
  "components/stat": async () => await import("@grasp-os/ui/components/stat"),
  "components/stepper": async () =>
    await import("@grasp-os/ui/components/stepper"),
  "components/suggestion": async () =>
    await import("@grasp-os/ui/components/suggestion"),
  "components/switch": async () =>
    await import("@grasp-os/ui/components/switch"),
  "components/table": async () => await import("@grasp-os/ui/components/table"),
  "components/table-of-contents": async () =>
    await import("@grasp-os/ui/components/table-of-contents"),
  "components/tabs": async () => await import("@grasp-os/ui/components/tabs"),
  "components/tags-input": async () =>
    await import("@grasp-os/ui/components/tags-input"),
  "components/terminal": async () =>
    await import("@grasp-os/ui/components/terminal"),
  "components/test-results": async () =>
    await import("@grasp-os/ui/components/test-results"),
  "components/text": async () => await import("@grasp-os/ui/components/text"),
  "components/textarea": async () =>
    await import("@grasp-os/ui/components/textarea"),
  "components/theme-toggle": async () =>
    await import("@grasp-os/ui/components/theme-toggle"),
  "components/toast": async () => await import("@grasp-os/ui/components/toast"),
  "components/toggle": async () =>
    await import("@grasp-os/ui/components/toggle"),
  "components/toggle-group": async () =>
    await import("@grasp-os/ui/components/toggle-group"),
  "components/tool": async () => await import("@grasp-os/ui/components/tool"),
  "components/tooltip": async () =>
    await import("@grasp-os/ui/components/tooltip"),
  "components/trace": async () => await import("@grasp-os/ui/components/trace"),
  "components/tree-view": async () =>
    await import("@grasp-os/ui/components/tree-view"),
  "blocks/app-shell-01": async () =>
    await import("@grasp-os/ui/blocks/app-shell-01/app-shell-01"),
  "blocks/connect-api-key-01": async () =>
    await import("@grasp-os/ui/blocks/connect-api-key-01/connect-api-key-01"),
  "blocks/inspector-01": async () =>
    await import("@grasp-os/ui/blocks/inspector-01/inspector-01"),
  "blocks/share-dialog-01": async () =>
    await import("@grasp-os/ui/blocks/share-dialog-01/share-dialog-01"),
};

const source = path.join(import.meta.dirname, "../../../packages/ui/src");

describe("Damsko's parts, as this app imports them", () => {
  it("lists every component and block installed", () => {
    const installed = [
      ...readdirSync(path.join(source, "components"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.name.endsWith(".tsx"))
        .map((entry) => `components/${entry.name.replace(/\.tsx$/u, "")}`),
      ...readdirSync(path.join(source, "blocks")).map(
        (block) => `blocks/${block}`
      ),
    ];
    expect(Object.keys(parts).toSorted()).toStrictEqual(installed.toSorted());
  });
});
