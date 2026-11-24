import { expect } from "@playwright/test";
import type { Locator } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";

// A project, end to end: a builder makes one, puts an App of theirs in it
// without sharing it, files one of their own chats in it, adds a
// colleague, who then finds the project and can change nothing in it, and
// takes the chat out again. What filing, sharing and membership grant is
// core's tests.

/** How long a page may take to show what core said. */
const pageRead = { timeout: 20_000 };

/** A side of a box on the page, in pixels. */
interface Edges {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A line of words or a control, as `layoutFaults` finds it. */
interface Measured {
  what: string;
  /** Which word or control it is; the lines of one run of words share it. */
  id: number;
  /** The controls around it or in it, by `id`. */
  around: number[];
  /** Its group of things that overlap by design, or -1. */
  group: number;
  rect: Edges;
  /** The nearest box that clips it, if any; with an ellipsis, a deliberate cut. */
  clip: (Edges & { ellipsis: boolean }) | null;
  window: number;
}

/**
 * The words and controls in `root` once what moves has come to rest (a
 * dialog sliding in, a list closing): each line of words, and each
 * control, button and link, with where they lie.
 */
const measure = async (root: Locator): Promise<Measured[]> =>
  await root.evaluate(async (element) => {
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (each) =>
            each.playState === "running" &&
            each.timeline === document.timeline &&
            each.effect?.getTiming().iterations !== Infinity
        )
        .map(async (each) => await each.finished.catch(() => each))
    );
    const controls = [...element.querySelectorAll("button, a, input, img")];
    // Faces in a group overlap by design, as a field and its own button.
    const groups = [
      ...element.querySelectorAll(
        "[data-slot=avatar-group], [data-slot=combobox]"
      ),
    ];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const words: Node[] = [];
    for (
      let node = walker.nextNode();
      node !== null;
      node = walker.nextNode()
    ) {
      words.push(node);
    }
    return [...controls, ...words].flatMap((node, id) => {
      const control = node instanceof Element;
      const at = control ? node : node.parentElement;
      const text = node.textContent?.trim() ?? "";
      if (
        at === null ||
        (!control && text === "") ||
        !at.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      ) {
        return [];
      }
      let clipper: Element | null = at;
      while (
        clipper !== null &&
        clipper !== element.parentElement &&
        getComputedStyle(clipper).overflowX === "visible"
      ) {
        clipper = clipper.parentElement;
      }
      const cut =
        clipper === null || clipper === element.parentElement
          ? null
          : clipper.getBoundingClientRect();
      const clip =
        clipper === null || cut === null
          ? null
          : {
              left: cut.left,
              right: cut.right,
              top: cut.top,
              bottom: cut.bottom,
              ellipsis: getComputedStyle(clipper).textOverflow === "ellipsis",
            };
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = control
        ? [node.getBoundingClientRect()]
        : [...range.getClientRects()];
      return rects.map((rect) => ({
        what: control
          ? (node.getAttribute("aria-label") ?? (text || node.tagName))
          : `"${text}"`,
        id,
        around: controls.flatMap((each, index) =>
          each !== node && (each.contains(node) || node.contains(each))
            ? [index]
            : []
        ),
        group: groups.findIndex((each) => each.contains(node)),
        rect: {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        },
        clip,
        window: document.documentElement.clientWidth,
      }));
    });
  });

/** Where `box` shows: within its clip where an ellipsis ends it. */
const shownPart = ({ rect, clip }: Measured): Edges =>
  clip?.ellipsis === true
    ? {
        ...rect,
        left: Math.max(rect.left, clip.left),
        right: Math.min(rect.right, clip.right),
      }
    : rect;

/** Whether `box` reaches past the window or the box that clips it. */
const cutOff = (box: Measured): boolean => {
  const { left, right } = shownPart(box);
  const { clip } = box;
  return (
    right > box.window + 0.5 ||
    left < -0.5 ||
    (clip !== null && (right > clip.right + 0.5 || left < clip.left - 0.5))
  );
};

/** Whether `one` and `other` lie over each other where neither holds the other. */
const overlap = (one: Measured, other: Measured): boolean => {
  if (
    one.id === other.id ||
    one.around.includes(other.id) ||
    other.around.includes(one.id) ||
    (one.group !== -1 && one.group === other.group)
  ) {
    return false;
  }
  const a = shownPart(one);
  const b = shownPart(other);
  return (
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
  );
};

/**
 * What is wrong with how `root` is laid out now: words or controls that
 * lie over one another, and words or controls cut off at the window's
 * edge or by a box that clips them without an ellipsis. Empty when it
 * reads well.
 */
const layoutFaults = async (root: Locator): Promise<string[]> => {
  // A box of a pixel or less holds words for a screen reader alone.
  const measured = await measure(root);
  const boxes = measured.filter(
    ({ rect, clip }) =>
      rect.right - rect.left > 1 &&
      (clip === null || clip.right - clip.left > 1)
  );
  const faults = boxes.filter(cutOff).map(({ what }) => `${what} is cut off`);
  for (const [index, one] of boxes.entries()) {
    for (const other of boxes.slice(index + 1)) {
      if (overlap(one, other)) {
        faults.push(`${one.what} lies over ${other.what}`);
      }
    }
  }
  return [...new Set(faults)];
};

test("a builder makes a project, files an App and a chat of theirs in it, and adds a colleague who only uses it", async ({
  pageOf,
}) => {
  const { builder, colleague } = peopleIn("projects");
  const tag = crypto.randomUUID().slice(0, 8);
  const appName = `Invoice desk ${tag}`;
  const chatTitle = `Budget review ${tag}`;
  const { core, api } = apiOf(builder);
  let chatId: string;
  try {
    await api.apps.create({ name: appName, description: "Invoices" });
    ({ id: chatId } = await api.chats.create(chatTitle));
  } finally {
    core[Symbol.dispose]();
  }

  const page = await pageOf(builder);
  await page.goto("/projects");
  // Nobody has put them in a project yet: making one is the way on.
  await expect(page.getByText("No projects yet")).toBeVisible(pageRead);
  await page.getByRole("button", { name: "New project" }).click();
  const making = page.getByRole("dialog", { name: "New project" });
  await making.getByRole("textbox", { name: "Name" }).fill(`Quotes ${tag}`);
  await making
    .getByRole("textbox", { name: "What it is for" })
    .fill("Every quote, from the ask to the yes");
  await making.getByRole("button", { name: "Rocket" }).click();
  await making.getByRole("button", { name: "Make project" }).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+$/u);
  const projectId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  await expect(
    page.getByRole("heading", { name: `Quotes ${tag}` })
  ).toBeVisible();
  await expect(page.getByText("No Apps in it yet.")).toBeVisible();

  // Their App, put in without sharing it with anyone.
  await page
    .getByRole("button", { name: `Add an App to Quotes ${tag}` })
    .click();
  const adding = page.getByRole("dialog", { name: `Add to Quotes ${tag}` });
  await adding.getByRole("combobox", { name: "App or workflow" }).fill(tag);
  await page.getByRole("option", { name: appName }).click();
  await expect(adding.getByRole("checkbox")).not.toBeChecked();
  await adding.getByRole("button", { name: "Add", exact: true }).click();
  await expect(adding).toHaveCount(0);
  const apps = page.getByRole("region", { name: "Apps" });
  await expect(apps.getByRole("link", { name: appName })).toBeVisible();
  await expect(apps).toContainText("Not shared with the project");

  // One of their own chats, which only they see in it.
  await page.getByRole("button", { name: "Add a chat" }).click();
  const filing = page.getByRole("dialog", { name: "Add a chat" });
  await filing.getByRole("searchbox", { name: "Find a chat" }).fill(tag);
  await filing
    .getByRole("listitem")
    .filter({ hasText: chatTitle })
    .getByRole("button", { name: "Add" })
    .click();
  await expect(filing).toHaveCount(0);
  const chats = page.getByRole("region", { name: "Your chats" });
  await expect(chats.getByRole("link", { name: chatTitle })).toBeVisible();

  // A colleague, as someone who uses it.
  await page.getByRole("button", { name: "Add people" }).click();
  const people = page.getByRole("dialog", { name: "People" });
  // Everyone here is called Person: the colleague is told apart by the end
  // of their ID.
  await people
    .getByRole("combobox", { name: "Search people and teams" })
    .click();
  await page
    .getByRole("option")
    .filter({ hasText: colleague.userId.slice(-6) })
    .click();
  await people.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    people
      .getByRole("list", { name: "People in the project" })
      .getByRole("listitem")
  ).toHaveCount(2);
  await people.getByRole("button", { name: "Close" }).last().click();
  await expect(
    page.getByRole("button", { name: "People in it: 2" })
  ).toBeVisible();

  const checks = apiOf(builder);
  try {
    const filed = await checks.api.chats.list({ project: projectId });
    expect(filed.map(({ id }) => id)).toStrictEqual([chatId]);
  } finally {
    checks.core[Symbol.dispose]();
  }

  // The colleague finds it, and nothing to change in it: not the App,
  // which filing shared with nobody, and never the builder's chat.
  const theirs = await pageOf(colleague);
  await theirs.goto("/projects");
  await theirs
    .getByRole("link", { name: new RegExp(`^Quotes ${tag}`, "u") })
    .click();
  await expect(
    theirs.getByRole("heading", { name: `Quotes ${tag}` })
  ).toBeVisible();
  await expect(theirs.getByText("No Apps in it yet.")).toBeVisible();
  await expect(theirs.getByRole("link", { name: appName })).toHaveCount(0);
  await expect(theirs.getByText(chatTitle)).toHaveCount(0);
  await expect(
    theirs.getByRole("button", { name: `More for Quotes ${tag}` })
  ).toHaveCount(0);
  await expect(theirs.getByRole("button", { name: "Add people" })).toHaveCount(
    0
  );

  // Taken out, the chat is theirs alone again, in no project.
  await chats
    .getByRole("button", { name: `Take ${chatTitle} out of the project` })
    .click();
  await expect(chats).toHaveCount(0);
  await expect(
    page.getByText("None of your chats are in it.", { exact: false })
  ).toBeVisible();
});

test("long names break inside their word, over nothing and cut off nowhere, on a laptop and a phone", async ({
  pageOf,
}) => {
  const { builder, colleague } = peopleIn("projectNames");
  const tag = crypto.randomUUID().slice(0, 8);
  // No space to break at, as a name copied from a file or a system is.
  const name = `customer_onboarding_pipeline_review_2026_${tag}`;
  const theirName = `colleague_with_a_very_long_name_from_the_directory_${tag}`;
  const ownName = `builder_with_a_very_long_name_from_the_directory_${tag}`;
  const theirs = apiOf(colleague);
  const own = apiOf(builder);
  let projectId: string;
  try {
    await theirs.api.setName(theirName);
    await own.api.setName(ownName);
    ({ id: projectId } = await own.api.projects.create({ name }));
    await own.api.projects.addMember(projectId, {
      type: "person",
      id: colleague.userId,
      role: "user",
    });
  } finally {
    theirs.core[Symbol.dispose]();
    own.core[Symbol.dispose]();
  }

  const page = await pageOf(builder);
  /** The page, the people and Add to it at `size`, each laid out well. */
  const readsWell = async (size: { width: number; height: number }) => {
    await page.setViewportSize(size);
    await page.goto(`/projects/${projectId}`);
    const heading = page.getByRole("heading", { level: 1, name });
    await expect(heading).toBeVisible(pageRead);
    const head = page.locator("header", { has: heading });
    expect({ size, faults: await layoutFaults(head) }).toStrictEqual({
      size,
      faults: [],
    });

    await page.getByRole("button", { name: "Add people" }).click();
    const people = page.getByRole("dialog", { name: "People" });
    await expect(people.getByText(theirName)).toBeVisible();
    expect({ size, faults: await layoutFaults(people) }).toStrictEqual({
      size,
      faults: [],
    });
    await people.getByRole("button", { name: "Close" }).last().click();
    await expect(people).toHaveCount(0);

    await page.getByRole("button", { name: `Add an App to ${name}` }).click();
    const adding = page.getByRole("dialog", { name: `Add to ${name}` });
    await expect(adding).toBeVisible();
    expect({ size, faults: await layoutFaults(adding) }).toStrictEqual({
      size,
      faults: [],
    });
    await page.keyboard.press("Escape");
    await expect(adding).toHaveCount(0);
  };
  await readsWell({ width: 1024, height: 768 });
  await readsWell({ width: 390, height: 844 });
});
