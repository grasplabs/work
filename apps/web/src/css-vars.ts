// The exception to "no inline styles": a place only data knows, such as a
// moment on a day's lane, which no class, variant or theme token can
// name. A ref sets it as a CSS custom property on the element, and its
// classes place it by that property (`left-(--x)`), so the look stays in
// classes and only the number comes from data.

/** A CSS custom property's name. */
type CssVar = `--${string}`;

/** A ref that sets `vars` on its element, as custom properties. */
export const cssVars =
  (vars: Readonly<Record<CssVar, string>>) =>
  (element: HTMLElement | null): void => {
    if (element === null) {
      return;
    }
    for (const [name, value] of Object.entries(vars)) {
      element.style.setProperty(name, value);
    }
  };
