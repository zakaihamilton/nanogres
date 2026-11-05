import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const identityControl = "http://127.0.0.1:4311/__test__";
const apiControl = "http://127.0.0.1:4312/__test__";
const syntheticUpload = Buffer.from("trusted isolated browser-test fixture".padEnd(41, "!"));
const previewScreens = [
  ["overview", "Your Postgres, in one place.", "Overview"],
  ["getting-started", "Connect your workspace to see your Postgres databases.", "Getting started"],
  ["databases", "Databases", "Databases"],
  ["database-new", "Create a database", "Create database"],
  ["delete-confirmation", "Delete database?", "Delete confirmation"],
  ["access", "Access & roles", "Access & roles"],
  ["access-new", "Create a database role", "Create role"],
  ["backups", "Backups", "Backups"],
  ["backups-new", "Create a backup now", "Create backup"],
  ["backups-restore", "Restore from a file", "Restore from file"],
  ["backups-restore-existing", "Restore a backup", "Restore retained backup"],
  ["activity", "Activity", "Activity"],
];

async function resetTestServices(request) {
  await Promise.all([
    request.post(`${identityControl}/reset`),
    request.post(`${apiControl}/reset`),
  ]);
}

async function chooseDropdown(page, label, optionLabel) {
  const trigger = page.getByRole("combobox", { name: label, exact: true });
  await trigger.click();
  await page.getByRole("option", { name: optionLabel, exact: true }).click();
}

async function signIn(page) {
  await page.goto("/");
  await page.getByRole("link", { name: "Open Workspace" }).first().click();
  await page.getByRole("link", { name: "Continue with Perminister" }).click();
  await page.getByRole("button", { name: "Continue as test admin" }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByRole("heading", { name: "Cluster Overview" })).toBeVisible();
}

async function settlePage(page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))),
      ),
  );
}

async function auditAccessibility(page) {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
    }));
  });
  expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
}

test("welcome, sign-in route, and protected dashboard entry are discoverable", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "A simpler, friendlier way to manage Postgres databases.",
    }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Open Workspace" }).first().click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in to Nanogres" })).toBeVisible();

  await page.goto("/overview");
  await expect(page).toHaveURL(/\/login$/);
});

test("email and password sign-in creates an HTTP-only browser session", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email or username").fill("nanogres-e2e@example.test");
  await page.getByLabel("Password").fill("test-only-password-for-browser-tests");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/overview$/);
  const cookie = (await page.context().cookies()).find((item) => item.name === "nanogres_session");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
});

test("keyboard users can skip navigation and land on the live page content", async ({ page }) => {
  await signIn(page);
  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  await expect(skipLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
});

test("the workspace first-run card completes the scoped access bootstrap", async ({
  page,
  request,
}) => {
  await resetTestServices(request);
  await request.post(`${identityControl}/configure`, { data: { bootstrapRequired: true } });
  await signIn(page);
  await expect(
    page.getByRole("heading", { name: "Grant your account access to this workspace." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Initialize workspace access" }).click();
  await expect(
    page.getByRole("heading", { name: "Grant your account access to this workspace." }),
  ).toBeHidden();
  await expect(page.getByRole("cell", { name: "app_main" })).toBeVisible();
  const cookie = (await page.context().cookies()).find((item) => item.name === "nanogres_session");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
});

test.describe("authenticated management journeys", () => {
  test.beforeEach(async ({ page, request }) => {
    await resetTestServices(request);
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
    });
    await signIn(page);
  });

  test("creates a database and role, then confirms deletion with keyboard-safe dialog", async ({
    page,
    request,
  }) => {
    await page.getByRole("link", { name: "Databases", exact: true }).click();
    await settlePage(page);
    await page.getByRole("link", { name: "Create database", exact: true }).click();
    await settlePage(page);
    await page.getByLabel("Database name").fill("e2e_project");
    await page.getByRole("button", { name: "Create database", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Database “e2e_project” created." }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Access & roles", exact: true }).click();
    await settlePage(page);
    await page.getByRole("link", { name: "Create role", exact: true }).click();
    await settlePage(page);
    await page.getByLabel("Role name").fill("e2e_reader");
    await chooseDropdown(page, "Database", "e2e_project");
    await chooseDropdown(page, "Access level", "Read-only");
    await page.getByLabel("Password", { exact: true }).fill("test-role-password-long-enough");
    await page.getByRole("button", { name: "Create role", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Role “e2e_reader” created for e2e_project." }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Databases", exact: true }).click();
    await settlePage(page);
    await page.getByRole("button", { name: "Delete e2e_project" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Delete database?" });
    await expect(dialog).toBeVisible();
    await expect(
      page.getByLabel("Type the database name exactly to enable deletion."),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("row", { name: /e2e_project/ })).toBeVisible();

    await page.getByRole("button", { name: "Delete e2e_project" }).click();
    const confirmName = page.getByLabel("Type the database name exactly to enable deletion.");
    await expect(page.getByRole("button", { name: "Delete permanently" })).toBeDisabled();
    await confirmName.fill("e2e_project");
    await page.getByRole("button", { name: "Delete permanently" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Database “e2e_project” deleted." }),
    ).toBeVisible();
    const state = await (await request.get(`${apiControl}/state`)).json();
    expect(state.databaseNames).not.toContain("e2e_project");
    expect(state.roleNames).toContain("e2e_reader");
  });

  test("creates and downloads a backup, restores it, and restores a selected file", async ({
    page,
    request,
  }) => {
    await page.getByRole("link", { name: "Backups", exact: true }).click();
    await settlePage(page);
    await page.getByRole("link", { name: "Create backup", exact: true }).click();
    await settlePage(page);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Create & download .dump" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^app_main__\d{8}T\d{12}Z\.dump$/);
    await expect(
      page.getByRole("status").filter({ hasText: "Created and downloaded" }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Back to backups" }).click();
    await settlePage(page);
    const restoreRetained = page.getByRole("link", {
      name: "Restore as new: app_main__20261104T120000000000Z.dump",
    });
    await restoreRetained.click();
    await settlePage(page);
    await page.getByLabel("New database name").fill("e2e_retained_restore");
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Confirm restore" })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Restore", exact: true }).click();
    await expect(
      page.getByRole("status").filter({
        hasText: "Restored app_main__20261104T120000000000Z.dump as e2e_retained_restore.",
      }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Back to backups" }).click();
    await settlePage(page);
    await page.getByRole("link", { name: "Restore from file" }).click();
    await settlePage(page);
    await page.getByLabel("PostgreSQL dump file").setInputFiles({
      name: "trusted-test.dump",
      mimeType: "application/octet-stream",
      buffer: syntheticUpload,
    });
    await page.getByLabel("New database name").fill("e2e_uploaded_restore");
    await page.getByRole("button", { name: "Restore from file" }).click();
    await expect(page.getByRole("dialog", { name: "Confirm restore" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Confirm restore" })).toBeHidden();
    const beforeConfirm = await (await request.get(`${apiControl}/state`)).json();
    expect(beforeConfirm.uploadCount).toBe(0);

    await page.getByRole("button", { name: "Restore from file" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Restore", exact: true }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Restored trusted-test.dump as e2e_uploaded_restore." }),
    ).toBeVisible();
    const state = await (await request.get(`${apiControl}/state`)).json();
    expect(state.databaseNames).toEqual(
      expect.arrayContaining(["e2e_retained_restore", "e2e_uploaded_restore"]),
    );
    expect(state.uploadCount).toBe(0);
  });

  test("starts a one-time PostgreSQL import and can cancel its job", async ({ page, request }) => {
    await resetTestServices(request);
    await signIn(page);
    await page.getByRole("link", { name: "Backups", exact: true }).click();
    await settlePage(page);
    await page.getByRole("link", { name: "Import / export database" }).click();
    await settlePage(page);
    await expect(page.getByRole("heading", { name: "Database transfers" })).toBeVisible();
    await page.getByLabel("New database name").fill("visitoring");
    await page
      .getByLabel("Source PostgreSQL connection string")
      .fill("postgresql://migrate:browser-secret@db.example/visitoring");
    await page.getByRole("button", { name: "Start import" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Transfer started" })).toBeVisible();
    await expect(page.getByLabel("Source PostgreSQL connection string")).toHaveValue("");

    const state = await (await request.get(`${apiControl}/state`)).json();
    expect(state.transfers).toHaveLength(1);
    expect(JSON.stringify(state.transfers)).not.toContain("browser-secret");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("cancelled", { exact: true })).toBeVisible();
  });

  test("surfaces workspace permission denial before a write reaches the workspace", async ({
    page,
    request,
  }) => {
    await request.post(`${identityControl}/configure`, {
      data: { deniedAction: "nanogres:members:manage" },
    });
    await page.getByRole("link", { name: "Databases", exact: true }).click();
    await settlePage(page);
    await page.getByRole("link", { name: "Create database", exact: true }).click();
    await settlePage(page);
    await page.getByLabel("Database name").fill("forbidden_project");
    await page.getByRole("button", { name: "Create database", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Perminister denied this action." }),
    ).toBeVisible();
    const state = await (await request.get(`${apiControl}/state`)).json();
    expect(state.databaseNames).not.toContain("forbidden_project");
  });

  test("reports and recovers from read outages", async ({ page, request }) => {
    await request.post(`${apiControl}/configure`, { data: { failReads: true } });
    await page.getByRole("link", { name: "Databases", exact: true }).click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "The Nanogres VPS API failed to complete the request." }),
    ).toBeVisible();
    await request.post(`${apiControl}/configure`, { data: { failReads: false } });
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("row", { name: /app_main/ })).toBeVisible();
  });

  test("shows useful empty states for backups and activity", async ({ page }) => {
    await page.goto("/backups");
    await expect(
      page.getByText("No backup files yet. The daily timer runs near 02:00 UTC."),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Create backup", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Restore from file" })).toBeVisible();

    await page.goto("/activity");
    await expect(page.getByText("No Nanogres operations recorded yet.")).toBeVisible();
  });

  test("shows a read permission denial without rendering workspace data", async ({
    page,
    request,
  }) => {
    await request.post(`${identityControl}/configure`, {
      data: { deniedAction: "nanogres:workspace:read" },
    });
    await page.goto("/databases");
    await expect(
      page.getByRole("alert").filter({ hasText: "Perminister denied this action." }),
    ).toBeVisible();
    await expect(page.getByRole("row", { name: /app_main/ })).toHaveCount(0);
  });

  test("warns when the latest verified off-site backup is stale", async ({ page, request }) => {
    await request.post(`${apiControl}/configure`, {
      data: {
        offsiteBackup: {
          configured: true,
          lastAttemptAt: "2026-11-02T12:00:00Z",
          lastSuccessAt: "2026-11-02T12:00:00Z",
          lastSuccessAgeSeconds: 172800,
          backupCount: 2,
          storedBytes: 1024,
          lastError: null,
          freshness: "stale",
        },
      },
    });
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByRole("status").filter({ hasText: "older than 36 hours" })).toBeVisible();
    await expect(page.getByText("Stale · verified")).toBeVisible();
  });

  test("cleans up an interrupted file upload and gives an actionable error", async ({
    page,
    request,
  }) => {
    await request.post(`${apiControl}/configure`, { data: { failNextUploadChunk: true } });
    await page.getByRole("link", { name: "Backups", exact: true }).click();
    await settlePage(page);
    await page.getByRole("link", { name: "Restore from file" }).click();
    await settlePage(page);
    await page.getByLabel("PostgreSQL dump file").setInputFiles({
      name: "interrupted.dump",
      mimeType: "application/octet-stream",
      buffer: syntheticUpload,
    });
    await page.getByLabel("New database name").fill("e2e_interrupted_restore");
    await page.getByRole("button", { name: "Restore from file" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Restore", exact: true }).click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "The Nanogres VPS API failed to complete the request." }),
    ).toBeVisible();
    const state = await (await request.get(`${apiControl}/state`)).json();
    expect(state.uploadCount).toBe(0);
    expect(state.databaseNames).not.toContain("e2e_interrupted_restore");
  });
});

test("the no-auth UI preview exposes and supports every page", async ({ page }) => {
  await page.goto("/ui-preview");
  await expect(
    page.getByText("Synthetic data only. Some actions simulate a result; others are disabled."),
  ).toBeVisible();
  for (const [screen, title, optionLabel] of previewScreens) {
    await chooseDropdown(page, "Preview screen", optionLabel);
    if (screen === "delete-confirmation") {
      await expect(page.getByRole("alertdialog", { name: "Delete database?" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("heading", { name: "Databases", exact: true })).toBeVisible();
    } else {
      await expect(page.getByRole("heading", { name: title, exact: true }).first()).toBeVisible();
    }
  }
});

test("custom preview dropdowns support keyboard selection and update the screen and theme", async ({
  page,
}) => {
  await page.goto("/ui-preview");
  const screenPicker = page.getByRole("combobox", { name: "Preview screen" });
  await screenPicker.focus();
  await screenPicker.press("End");
  await expect(page.getByRole("listbox")).toBeVisible();
  expect(await page.getByRole("option", { name: "Activity" }).getAttribute("data-active")).toBe(
    "true",
  );
  await screenPicker.press("Enter");
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();

  await chooseDropdown(page, "Color theme", "Dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("public, preview, and authenticated screens meet WCAG 2.1 AA automated checks", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await auditAccessibility(page);
  await page.goto("/login");
  await auditAccessibility(page);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.waitForTimeout(200);
  await auditAccessibility(page);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await page.waitForTimeout(200);
  await page.goto("/ui-preview");
  const screenPicker = page.getByRole("combobox", { name: "Preview screen" });
  await screenPicker.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await auditAccessibility(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  for (const [screen, , optionLabel] of previewScreens) {
    await chooseDropdown(page, "Preview screen", optionLabel);
    if (screen === "delete-confirmation") await expect(page.getByRole("alertdialog")).toBeVisible();
    else await expect(page.locator("main").last()).toBeVisible();
    await auditAccessibility(page);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await page.waitForTimeout(200);
    await auditAccessibility(page);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    await page.waitForTimeout(200);
    if (screen === "delete-confirmation") {
      await page.keyboard.press("Escape");
      await chooseDropdown(page, "Preview screen", "Databases");
    }
  }
  await resetTestServices(request);
  await signIn(page);
  await auditAccessibility(page);
  for (const [href, heading] of [
    ["/databases", "Databases"],
    ["/databases/new", "Create a database"],
    ["/access", "Access & roles"],
    ["/access/new", "Create a database role"],
    ["/backups", "Backups"],
    ["/backups/new", "Create a backup"],
    ["/backups/restore", "Restore from a file"],
    ["/backups/transfers", "Database transfers"],
    ["/activity", "Activity"],
  ]) {
    await page.goto(href);
    await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeVisible();
    await auditAccessibility(page);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await page.waitForTimeout(200);
    await auditAccessibility(page);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    await page.waitForTimeout(200);
    if (href === "/databases") {
      await page.getByRole("button", { name: "Delete app_main" }).click();
      await expect(page.getByRole("alertdialog", { name: "Delete database?" })).toBeVisible();
      await auditAccessibility(page);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("alertdialog")).toBeHidden();
    }
    if (href === "/backups/restore") {
      await page.getByLabel("PostgreSQL dump file").setInputFiles({
        name: "accessibility-test.dump",
        mimeType: "application/octet-stream",
        buffer: syntheticUpload,
      });
      await page.getByLabel("New database name").fill("e2e_a11y_restore");
      await page.getByRole("button", { name: "Restore from file" }).click();
      await expect(page.getByRole("dialog", { name: "Confirm restore" })).toBeVisible();
      await auditAccessibility(page);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Confirm restore" })).toBeHidden();
    }
  }
});

test("the preview keeps every screen within narrow viewports and respects reduced motion", async ({
  page,
  request,
}) => {
  await page.goto("/ui-preview");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 844 });
  for (const [screen, , optionLabel] of previewScreens) {
    await chooseDropdown(page, "Preview screen", optionLabel);
    await page.waitForTimeout(40);
    const dimensions = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      htmlOverflowX: getComputedStyle(document.documentElement).overflowX,
      bodyOverflowX: getComputedStyle(document.body).overflowX,
    }));
    expect(dimensions.body, `${screen} at 320px`).toBeLessThanOrEqual(320);
    expect(dimensions.htmlOverflowX, `${screen} at 320px`).toBe("clip");
    expect(dimensions.bodyOverflowX, `${screen} at 320px`).toBe("clip");
    if (screen === "overview") {
      const tableScroll = await page
        .locator('[role="region"][aria-label="Databases"]')
        .evaluate((element) => {
          const canScroll = element.scrollWidth > element.clientWidth;
          element.scrollLeft = 64;
          return { canScroll, scrollLeft: element.scrollLeft };
        });
      expect(tableScroll.canScroll).toBe(true);
      expect(tableScroll.scrollLeft).toBeGreaterThan(0);
    }
    if (screen === "delete-confirmation") {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("alertdialog")).toBeHidden();
      await chooseDropdown(page, "Preview screen", "Databases");
    }
  }
  const transitionDuration = await page
    .getByRole("link", { name: "Overview", exact: true })
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(transitionDuration.split(",").every((duration) => Number.parseFloat(duration) === 0)).toBe(
    true,
  );

  for (const width of [375, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await chooseDropdown(page, "Preview screen", "Overview");
    await page.mouse.move(width / 2, 10);
    await page.mouse.wheel(500, 0);
    expect(await page.evaluate(() => window.scrollX), `preview at ${width}px`).toBe(0);
    await page.mouse.wheel(-500, 0);
  }

  await resetTestServices(request);
  await signIn(page);
  for (const width of [320, 375, 768]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [href, heading] of [
      ["/overview", "Cluster Overview"],
      ["/databases", "Databases"],
      ["/databases/new", "Create a database"],
      ["/access", "Access & roles"],
      ["/access/new", "Create a database role"],
      ["/backups", "Backups"],
      ["/backups/new", "Create a backup"],
      ["/backups/restore", "Restore from a file"],
      ["/activity", "Activity"],
    ]) {
      await page.goto(href);
      await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeVisible();
      const layout = await page.evaluate(() => ({
        bodyWidth: document.body.scrollWidth,
        htmlOverflowX: getComputedStyle(document.documentElement).overflowX,
        bodyOverflowX: getComputedStyle(document.body).overflowX,
      }));
      expect(layout.bodyWidth, `${href} at ${width}px`).toBeLessThanOrEqual(width);
      expect(layout.htmlOverflowX, `${href} at ${width}px`).toBe("clip");
      expect(layout.bodyOverflowX, `${href} at ${width}px`).toBe("clip");
      if (href === "/overview") {
        await page.mouse.move(width / 2, 10);
        await page.mouse.wheel(500, 0);
        expect(await page.evaluate(() => window.scrollX), `${href} at ${width}px`).toBe(0);
        await page.mouse.wheel(-500, 0);
      }
    }
  }
});
