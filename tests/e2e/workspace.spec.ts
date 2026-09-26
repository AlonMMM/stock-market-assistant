import { expect, test } from "@playwright/test";
test("mobile replay shows evidence, correct proportions and clears stale results", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByText("DEMO DATA", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run replay", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "NVDA · 3.4× volume" }),
  ).toBeVisible();
  await expect(page.getByText("170,000", { exact: true })).toBeVisible();
  const ratio = await page
    .locator(".bar.expected")
    .evaluate(
      (el) =>
        el.getBoundingClientRect().width /
        el.parentElement!.getBoundingClientRect().width,
    );
  expect(ratio).toBeCloseTo(1 / 3.4, 2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/replay-mobile.png",
    fullPage: true,
  });
  await page.getByLabel("Alert ratio").fill("6");
  await expect(
    page.getByRole("heading", { name: "NVDA · 3.4× volume" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Run replay", exact: true }).click();
  await expect(
    page.getByText("No alerts matched these settings."),
  ).toBeVisible();
});
test("API failure is visible and retry recovers", async ({ page }) => {
  await page.goto("/");
  await page.route("**/api/replay", (route) => route.abort());
  await page.getByRole("button", { name: "Run replay", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.unroute("**/api/replay");
  await page.getByRole("button", { name: "Run replay", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "NVDA · 3.4× volume" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({
    path: "test-results/replay-desktop.png",
    fullPage: true,
  });
});
test("historical upload and return to demo keep provenance clear", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Historical bars", { exact: true }).setInputFiles({
    name: "history.json",
    mimeType: "application/json",
    buffer: Buffer.from("[]"),
  });
  await page.getByRole("button", { name: "Run replay", exact: true }).click();
  await expect(
    page.getByText("Historical replay", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Use demo", exact: true }).click();
  await expect(page.getByText("DEMO DATA", { exact: true })).toBeVisible();
  await page.getByLabel("Cooldown (min)").fill("30");
  await page.getByRole("button", { name: "Run replay", exact: true }).click();
  await expect(
    page.getByText(/20 historical samples · Rule v1 · 30 min cooldown/),
  ).toBeVisible();
});
