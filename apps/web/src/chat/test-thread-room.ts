// happy-dom lays nothing out, so Grasp UI's Thread, which draws only the
// rows its view has room for, would see a view 0px tall and draw none, and
// its scroll to the end would go below zero, which no browser allows. Its
// tests give every element room enough for the whole thread, and keep the
// scroll where a browser keeps it: at the top, with nothing to scroll.

/** A view taller than any thread in the tests. */
const roomPx = 100_000;

Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get: () => roomPx,
});

Object.defineProperty(HTMLElement.prototype, "scrollTop", {
  configurable: true,
  get: () => 0,
  set: () => {
    // Everything is in view: there is nowhere to scroll to.
  },
});
