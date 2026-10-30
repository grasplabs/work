// Light or dark as the system has it, through the theme's `dark` class.
// Loaded as a classic script in <head>, so it runs before first paint and
// dark mode never flashes light. A file, not inline, so it needs no inline
// script. The admin has no choice of its own, so it follows the system.
{
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    document.documentElement.classList.toggle("dark", dark.matches);
  };
  apply();
  dark.addEventListener("change", apply);
}
