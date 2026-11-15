import { expect, test } from "@playwright/test";

const widths = [320, 390, 768, 1024, 1280];
const previewScreens = [
  ["overview", "Overview"],
  ["getting-started", "Getting started"],
  ["databases", "Databases"],
  ["database-new", "Create database"],
  ["delete-confirmation", "Delete confirmation"],
  ["access", "Access & roles"],
  ["access-new", "Create role"],
  ["backups", "Backups"],
  ["backups-new", "Create backup"],
  ["backups-restore", "Restore from file"],
  ["backups-restore-existing", "Restore retained backup"],
  ["activity", "Activity"],
  ["sql-editor", "SQL Editor"],
];

async function chooseDropdown(page, label, optionLabel) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: optionLabel, exact: true }).click();
}

async function settleLayout(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))),
      ),
  );
}

async function readLayout(page) {
  return page.evaluate(() => {
    const rect = (element) => {
      if (!element) return null;
      const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
      return { x, y, width, height, right, bottom };
    };
    const visible = (element) => {
      const box = rect(element);
      return box && box.width > 0 && box.height > 0;
    };
    const content = document.querySelector(".pf-dashboard-content");
    const contentBox = rect(content);
    const contentStyle = content && getComputedStyle(content);
    const contentPadding = contentStyle
      ? {
          top: Number.parseFloat(contentStyle.paddingTop),
          right: Number.parseFloat(contentStyle.paddingRight),
          bottom: Number.parseFloat(contentStyle.paddingBottom),
          left: Number.parseFloat(contentStyle.paddingLeft),
        }
      : null;
    const commandButton = document.querySelector('button[aria-label^="Commands"]');
    const toolbarRow = commandButton?.parentElement?.parentElement;
    const dashboardToolbar = commandButton?.closest(".pf-dashboard-toolbar");
    const shell = document.querySelector(".pf-dashboard-shell");
    const toolbarStyle = dashboardToolbar && getComputedStyle(dashboardToolbar);
    const toolbarChildren = toolbarRow
      ? [...toolbarRow.children].filter(visible).map(rect)
      : [];
    const headings = [...document.querySelectorAll("main h1")].filter(visible);
    const heading = headings[0];
    const headingRow = heading?.parentElement?.parentElement;
    const headingChildren = headingRow
      ? [...headingRow.children].filter(visible).map(rect)
      : [];
    const headingStyle = headingRow && getComputedStyle(headingRow);
    const headingDescription = heading?.nextElementSibling;
    const headingRoot = heading?.parentElement?.parentElement?.parentElement;
    const headingRootStyle = headingRoot && getComputedStyle(headingRoot);
    const overlaps = (boxes) => {
      const pairs = [];
      for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
          const left = boxes[leftIndex];
          const right = boxes[rightIndex];
          if (
            Math.min(left.right, right.right) - Math.max(left.x, right.x) > 1 &&
            Math.min(left.bottom, right.bottom) - Math.max(left.y, right.y) > 1
          ) {
            pairs.push([leftIndex, rightIndex]);
          }
        }
      }
      return pairs;
    };
    const contentInner = contentBox && contentPadding
      ? {
          left: contentBox.x + contentPadding.left,
          right: contentBox.right - contentPadding.right,
        }
      : null;
    const headingWithinContent =
      headingRow && contentInner
        ? (() => {
            const box = rect(headingRow);
            return {
              left: box.x >= contentInner.left - 1,
              right: box.right <= contentInner.right + 1,
            };
          })()
        : null;
    const headingMargin = heading
      ? {
          top: Number.parseFloat(getComputedStyle(heading).marginTop),
          bottom: Number.parseFloat(getComputedStyle(heading).marginBottom),
        }
      : null;
    const alertDialog = document.querySelector('[role="alertdialog"]');
    const databaseRegion = document.querySelector('[role="region"][aria-label="Databases"]');
    const databasePanel = databaseRegion?.parentElement?.parentElement;
    const inTableScrollRegion = (element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const overflowX = getComputedStyle(parent).overflowX;
        if (overflowX === "auto" || overflowX === "scroll") {
          const box = rect(parent);
          if (box && box.x >= -1 && box.right <= window.innerWidth + 1) return true;
        }
      }
      return false;
    };
    const overflowNodes = [...document.body.querySelectorAll("*")]
      .map((element) => ({ element, box: rect(element) }))
      .filter(
        ({ element, box }) =>
          box &&
          box.width > 0 &&
          box.right > window.innerWidth + 1 &&
          !inTableScrollRegion(element),
      )
      .sort((left, right) => right.box.right - left.box.right)
      .slice(0, 8)
      .map(({ element, box }) => ({
        tag: element.tagName.toLowerCase(),
        className: typeof element.className === "string" ? element.className : "",
        id: element.id,
        right: box.right,
        width: box.width,
        overflowX: getComputedStyle(element).overflowX,
      }));

    return {
      viewportWidth: window.innerWidth,
      // The table's scrollable contents can contribute to root scrollWidth even when the page fits.
      documentWidth: document.body.scrollWidth,
      rootScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      bodyRectWidth: document.body.getBoundingClientRect().width,
      pageScrollX: window.scrollX,
      overflowNodes,
      shellBox: rect(shell),
      contentPadding,
      contentBox,
      databaseRegion: {
        box: rect(databaseRegion),
        parentBox: rect(databasePanel),
      },
      toolbar: {
        box: rect(dashboardToolbar),
        paddingLeft: toolbarStyle ? Number.parseFloat(toolbarStyle.paddingLeft) : null,
        paddingRight: toolbarStyle ? Number.parseFloat(toolbarStyle.paddingRight) : null,
        children: toolbarChildren,
        overlaps: overlaps(toolbarChildren),
      },
      heading: heading
        ? {
            text: heading.textContent?.trim(),
            box: rect(headingRow),
            children: headingChildren,
            overlaps: overlaps(headingChildren),
            withinContent: headingWithinContent,
            gap: headingStyle ? Number.parseFloat(headingStyle.gap) : null,
            titleMargin: headingMargin,
            descriptionMarginTop: headingDescription
              ? Number.parseFloat(getComputedStyle(headingDescription).marginTop)
              : null,
            screenGap: headingRootStyle ? Number.parseFloat(headingRootStyle.gap) : null,
          }
        : null,
      alertDialog: rect(alertDialog),
    };
  });
}

function expectNear(actual, expected, label, tolerance = 1) {
  expect(Math.abs(actual - expected), `${label}: expected ${expected}px, got ${actual}px`).toBeLessThanOrEqual(
    tolerance,
  );
}

async function checkViewport(page, width, theme, screen) {
  await settleLayout(page);
  const layout = await readLayout(page);
  const context = `${screen} at ${width}px in ${theme} theme`;

  expect(layout.viewportWidth, context).toBe(width);
  expect(
    layout.documentWidth,
    `${context}: document body must fit its viewport; root scroll area=${layout.rootScrollWidth}px; overflowing nodes: ${JSON.stringify(layout.overflowNodes)}`,
  ).toBeLessThanOrEqual(width);
  expect(layout.bodyScrollWidth, `${context}: document body width`).toBeLessThanOrEqual(width);
  expect(layout.bodyRectWidth, `${context}: document body bounds`).toBeLessThanOrEqual(width);
  expect(layout.pageScrollX, `${context}: document must not scroll horizontally`).toBe(0);
  expect(layout.shellBox.x, `${context}: dashboard shell left edge`).toBeGreaterThanOrEqual(-1);
  expect(layout.shellBox.right, `${context}: dashboard shell right edge`).toBeLessThanOrEqual(width + 1);
  expect(layout.contentBox.x, `${context}: content left edge`).toBeGreaterThanOrEqual(-1);
  expect(layout.contentBox.right, `${context}: content right edge`).toBeLessThanOrEqual(width + 1);
  expect(layout.toolbar.box.x, `${context}: toolbar left edge`).toBeGreaterThanOrEqual(-1);
  expect(layout.toolbar.box.right, `${context}: toolbar right edge`).toBeLessThanOrEqual(width + 1);

  if (screen === "overview") {
    expect(layout.databaseRegion.box.x, `${context}: table region left edge`).toBeGreaterThanOrEqual(
      layout.databaseRegion.parentBox.x - 1,
    );
    expect(layout.databaseRegion.box.right, `${context}: table region right edge`).toBeLessThanOrEqual(
      layout.databaseRegion.parentBox.right + 1,
    );
    const databaseTable = page.getByRole("region", { name: "Databases", exact: true });
    const tableScroll = await databaseTable.evaluate((element) => {
      const canScroll = element.scrollWidth > element.clientWidth;
      element.scrollLeft = 64;
      return { canScroll, scrollLeft: element.scrollLeft };
    });
    expect(tableScroll.canScroll, `${context}: database table must keep its scroll area`).toBe(true);
    expect(tableScroll.scrollLeft, `${context}: database table must scroll independently`).toBeGreaterThan(
      0,
    );
  }

  const expectedContentPadding = width <= 780
    ? { top: 20, right: 16, bottom: 32, left: 16 }
    : { top: Math.min(42, Math.max(20, width * 0.03)) };
  for (const [edge, expected] of Object.entries(expectedContentPadding)) {
    expectNear(layout.contentPadding[edge], expected, `${context}: content ${edge} padding`);
  }
  if (width > 780) {
    expectNear(layout.contentPadding.right, expectedContentPadding.top, `${context}: content right padding`);
    expectNear(layout.contentPadding.bottom, expectedContentPadding.top, `${context}: content bottom padding`);
    expectNear(layout.contentPadding.left, expectedContentPadding.top, `${context}: content left padding`);
  }

  const expectedToolbarPadding = width <= 780 ? 14 : Math.min(42, Math.max(18, width * 0.03));
  expectNear(layout.toolbar.paddingLeft, expectedToolbarPadding, `${context}: toolbar left padding`);
  expectNear(layout.toolbar.paddingRight, expectedToolbarPadding, `${context}: toolbar right padding`);
  expect(layout.toolbar.overlaps, `${context}: toolbar items must not overlap`).toEqual([]);

  if (layout.heading) {
    const sqlEditor = screen === "sql-editor";
    const expectedHeadingGap = sqlEditor ? 16 : width <= 500 ? 13 : 20;
    const expectedScreenGap = sqlEditor || width <= 720 ? 16 : 20;
    expect(layout.heading.overlaps, `${context}: heading and actions must not overlap`).toEqual([]);
    expect(layout.heading.withinContent, `${context}: heading must stay within content gutters`).toEqual({
      left: true,
      right: true,
    });
    expectNear(layout.heading.gap, expectedHeadingGap, `${context}: heading gap`);
    expectNear(layout.heading.screenGap, expectedScreenGap, `${context}: screen section gap`);
    expectNear(layout.heading.titleMargin.top, 0, `${context}: title top margin`);
    expectNear(layout.heading.titleMargin.bottom, 0, `${context}: title bottom margin`);
    expectNear(
      layout.heading.descriptionMarginTop,
      sqlEditor ? 2 : 9,
      `${context}: title description spacing`,
    );
  }

  if (layout.alertDialog) {
    expect(layout.alertDialog.x, `${context}: dialog left edge`).toBeGreaterThanOrEqual(0);
    expect(layout.alertDialog.right, `${context}: dialog right edge`).toBeLessThanOrEqual(width);
  }
}

test("synthetic preview stays within responsive layout and spacing contracts", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/ui-preview");
  await chooseDropdown(page, "Preview scenario", "Long database and organization names");

  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      for (const [screen, label] of previewScreens.filter(([value]) => value !== "sql-editor")) {
        await chooseDropdown(page, "Preview screen", label);
        await checkViewport(page, width, theme, screen);
        if (screen === "delete-confirmation") {
          await page.keyboard.press("Escape");
          await expect(page.getByRole("alertdialog")).toBeHidden();
        }
      }

      await chooseDropdown(page, "Preview scenario", "SQL wide results");
      await page.setViewportSize({ width, height: 900 });
      await checkViewport(page, width, theme, "sql-editor");
      await chooseDropdown(page, "Preview scenario", "Long database and organization names");
    }
  }
});

test("synthetic preview dropdowns share a height", async ({ page }) => {
  await page.goto("/ui-preview");

  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    const heights = await page.locator(".ui-preview-toolbar .pf-select-trigger").evaluateAll(
      (triggers) => triggers.map((trigger) => trigger.getBoundingClientRect().height),
    );

    expect(heights.length, `${width}px preview toolbar dropdown count`).toBe(3);
    expect(
      Math.max(...heights) - Math.min(...heights),
      `${width}px preview toolbar dropdown heights`,
    ).toBeLessThanOrEqual(1);
  }
});
