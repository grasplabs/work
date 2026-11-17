// Light, dark, or the system's colour scheme, through the theme's `dark`
// class, and the theme's colours (Evergreen, Pine, Paper) through Grasp
// UI's `data-grasp-theme` and `data-grasp-mode` (what its themeScript sets,
// grasp/theme/script.ts). Loaded as a classic script in <head>, so it runs
// before first paint and nothing flashes. A file, not inline: the CSP
// allows no inline script.
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

/**
 * What this browser keeps under `key`, or null where storage is blocked.
 * @param {string} key The storage key.
 * @returns {string | null} What it holds, or null.
 */
const readKept = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage blocked: the defaults.
    return null;
  }
};

{
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const modes = new Set(["light", "dark", "system"]);
  const ids = new Set(["evergreen", "pine", "paper"]);
  const apply = () => {
    const root = document.documentElement;
    const theme = readKept("grasp-theme");
    const id = readKept("grasp-theme-id");
    const isDark = theme === "dark" || (theme !== "light" && dark.matches);
    root.classList.toggle("dark", isDark);
    root.dataset.graspMode = modes.has(theme) ? theme : "system";
    root.dataset.graspTheme = ids.has(id) ? id : "evergreen";
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
