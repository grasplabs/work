// Light, dark, or the system's colour scheme, through the theme's `dark`
// class. Loaded as a classic script in <head>, so it runs before first paint
// and dark mode never flashes light. A file, not inline: the CSP allows no
// inline script.
//
// The choice is the person's, kept in this browser (src/frame/theme.ts):
// `grasp-theme` holds the one applied last, so the first paint already has
// it, and the app writes it again once it knows who is signed in. It tells
// this script with a `grasp-theme` event; another tab, through `storage`.
{
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    let theme = null;
    try {
      theme = localStorage.getItem("grasp-theme");
    } catch {
      // Storage blocked: follow the system.
    }
    const isDark = theme === "dark" || (theme !== "light" && dark.matches);
    document.documentElement.classList.toggle("dark", isDark);
  };
  apply();
  dark.addEventListener("change", apply);
  document.addEventListener("grasp-theme", apply);
  addEventListener("storage", (event) => {
    if (event.key === "grasp-theme") {
      apply();
    }
  });
}
