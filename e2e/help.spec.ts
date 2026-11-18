import { expect, test } from "@playwright/test";
import { seatTable, startRound } from "./fixtures.js";

test.describe("the rules help", () => {
  test("opens from the corner of the table and closes again", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByTestId("rules-panel")).toBeHidden();
    await page.getByTestId("rules-button").click();

    await expect(page.getByTestId("rules-panel")).toBeVisible();
    await expect(page.getByTestId("rules-panel")).toContainText(/fewest points/i);

    await page.getByTestId("rules-panel").getByRole("button", { name: "Close" }).click();
    await expect(page.getByTestId("rules-panel")).toBeHidden();
  });

  test("opens with i and closes with Escape", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("name-input")).toBeVisible();
    // Blur the name field; typing a name must never open the rule book.
    await page.getByTestId("rules-button").focus();

    await page.keyboard.press("i");
    await expect(page.getByTestId("rules-panel")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("rules-panel")).toBeHidden();
  });

  test("stays shut while a name is being typed", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("name-input").fill("");
    await page.getByTestId("name-input").pressSequentially("Winifred");

    await expect(page.getByTestId("name-input")).toHaveValue("Winifred");
    await expect(page.getByTestId("rules-panel")).toBeHidden();
  });

  test("explains the slap queue at the table, without arming a slap", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana] = players;
    await startRound(players);

    await ana!.page.getByTestId("rules-button").click();

    await expect(ana!.page.getByTestId("rules-panel")).toContainText(/a faster slap does not cancel a slower one/i);
    // Reading the rules is not playing: no card became a slap target.
    await expect(ana!.slot(0)).not.toHaveClass(/card--slap/);

    for (const player of players) await player.close();
  });

  test("stands the slapping keys down while it is open", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana] = players;
    await startRound(players);

    await ana!.page.getByTestId("rules-button").click();
    await expect(ana!.page.getByTestId("rules-panel")).toBeVisible();

    // The two keys that would otherwise cost Ana a card mid-sentence.
    await ana!.page.keyboard.press("s");
    await ana!.page.keyboard.press("1");

    await expect(ana!.slot(0)).not.toHaveClass(/card--slap/);
    await expect(ana!.page.getByTestId("toast")).toHaveCount(0);
    await expect(ana!.page.getByTestId("slap-button")).toHaveText("SLAP");

    for (const player of players) await player.close();
  });
});
