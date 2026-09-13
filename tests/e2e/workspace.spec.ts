import { expect, test } from "@playwright/test";

test("website connects through the proxy to the real API", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("Workspace connected");
  await expect(
    page.getByText(
      "Market data is not connected. Alerts and notifications are not active.",
    ),
  ).toBeVisible();
});

test("connection failure is visible and retry recovers on a phone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/health", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByRole("status")).toContainText("Workspace unavailable");
  await page.unroute("**/api/health");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("status")).toHaveText("Workspace connected");
});
