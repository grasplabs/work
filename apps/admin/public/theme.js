// Light or dark before first paint, so dark mode never flashes light: what
// staff chose in the sidebar's menu (kept in this browser), or the system's.
{
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    let mode = "system";
    try {
      mode = localStorage.getItem("grasp.admin.theme") ?? "system";
    } catch {
      // Storage refused: the system's.
    }
    document.documentElement.classList.toggle(
      "dark",
      mode === "dark" || (mode === "system" && dark.matches)
    );
    // Damsko's parts read the same choice from `data-mode`: their colours
    // follow the root's `color-scheme`, which its themes.css sets from it.
    document.documentElement.dataset.mode = mode;
  };
  apply();
  dark.addEventListener("change", apply);
}
