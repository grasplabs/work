// Light, dark, or the system's colour scheme, through the theme's `dark`
// class and, for Damsko's components, the `data-mode` attribute; and
// Damsko's theme, its colours (Evergreen, Pine, Paper), as the root's
// `data-theme`, which index.html starts at Evergreen. Loaded as a classic
// script in <head>, so it runs before first paint and nothing flashes. A
// file, not inline: the CSP allows no inline script.
//
// The choice is the person's, kept in this browser (src/frame/theme.ts):
// `grasp-theme` holds the one applied last, so the first paint already has
// it, and the app writes it again once it knows who is signed in. It tells
// this script with a `grasp-theme` event; another tab, through `storage`.
//
// It also keeps Zod jitless. The page's CSP (core's src/security-headers.ts)
// allows no eval, and Zod probes for it with `new Function` when a schema is
// built, which the browser reports as a violation even though Zod catches
// the error. Zod reads this global when it loads, so set here, before any
// module runs, it holds for every schema whichever chunk builds it, without
// making the bundler run modules in import order.
globalThis.__zod_globalConfig = { jitless: true };

{
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const ids = new Set(["evergreen", "pine", "paper"]);
  const apply = () => {
    let theme = null;
    let id = null;
    try {
      theme = localStorage.getItem("grasp-theme");
      id = localStorage.getItem("grasp-theme-id");
    } catch {
      // Storage blocked: follow the system, in Evergreen.
    }
    const isDark = theme === "dark" || (theme !== "light" && dark.matches);
    document.documentElement.classList.toggle("dark", isDark);
    // Damsko's components (packages/ui) read the same choice from
    // `data-mode`: their colours follow the root's `color-scheme`, which
    // its themes.css sets from it.
    document.documentElement.dataset.mode =
      theme === "light" || theme === "dark" ? theme : "system";
    document.documentElement.dataset.theme = ids.has(id) ? id : "evergreen";
  };
  apply();
  dark.addEventListener("change", apply);
  document.addEventListener("grasp-theme", apply);
  addEventListener("storage", (event) => {
    if (event.key === "grasp-theme" || event.key === "grasp-theme-id") {
      apply();
    }
  });
}
