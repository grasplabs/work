/**
 * What an App page's frame does with a submission the browser starts (a
 * submit button's click, Enter in a field, requestSubmit): it is sandboxed
 * without forms, so it never fires the submit event. A capturing listener
 * on the window, it drops each such event before the page sees it; one a
 * page dispatches itself passes.
 */
export const submissionRefused = (event: Event): void => {
  if (event.isTrusted) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
};
