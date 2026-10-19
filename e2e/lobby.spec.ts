import { expect, test } from "@playwright/test";
import { Player, seatTable, startRound } from "./fixtures.js";

test.describe("the lobby", () => {
  test("creates a table and shows a shareable code", async ({ browser }) => {
    const host = await Player.open(browser, "Ana");
    const code = await host.createTable();

    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    await expect(host.page.getByTestId("lobby-player-Ana")).toBeVisible();
    await expect(host.page.getByTestId("start-button")).toBeVisible();
    await host.close();
  });

  test("will not start a table of one", async ({ browser }) => {
    const host = await Player.open(browser, "Ana");
    await host.createTable();

    await expect(host.page.getByTestId("start-button")).toBeDisabled();
    await expect(host.page.getByTestId("start-button")).toContainText("Waiting for");
    await host.close();
  });

  test("lets a second player join by code and shows both to each other", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana, bo] = players;

    await expect(ana!.page.getByTestId("lobby-player-Bo")).toBeVisible();
    await expect(bo!.page.getByTestId("lobby-player-Ana")).toBeVisible();
    // Only the creator is host, and only the host sees the start control.
    await expect(bo!.page.getByTestId("waiting-for-host")).toBeVisible();
    await expect(bo!.page.getByTestId("start-button")).toHaveCount(0);

    for (const player of players) await player.close();
  });

  test("rejects a code that belongs to no table", async ({ browser }) => {
    const player = await Player.open(browser, "Ana");
    await player.page.getByTestId("code-input").fill("ZZZZZZ");
    await player.page.getByTestId("join-button").click();

    await expect(player.page.getByTestId("toast")).toContainText(/no room/i);
    await player.close();
  });

  test("only the host sees the remove buttons", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana, bo] = players;

    await expect(ana!.page.getByTestId("kick-Bo")).toBeVisible();
    await expect(bo!.page.getByTestId("kick-Ana")).toHaveCount(0);

    for (const player of players) await player.close();
  });

  test("kicking removes the player and tells them so", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo", "Cy"]);
    const [ana, bo, cy] = players;

    await ana!.page.getByTestId("kick-Bo").click();

    // The kicked tab is ejected back to the start, with an explanation.
    await expect(bo!.page.getByTestId("kicked-banner")).toBeVisible();
    await expect(bo!.page.getByTestId("kicked-banner")).toContainText(/host/i);
    await expect(bo!.page.getByTestId("name-input")).toBeVisible();

    // Everyone still at the table sees them gone.
    await expect(ana!.page.getByTestId("lobby-player-Bo")).toHaveCount(0);
    await expect(cy!.page.getByTestId("lobby-player-Bo")).toHaveCount(0);
    await expect(cy!.page.getByTestId("lobby-player-Cy")).toBeVisible();

    for (const player of players) await player.close();
  });

  test("a kicked player cannot get back in by reloading", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana, bo] = players;

    await ana!.page.getByTestId("kick-Bo").click();
    await expect(bo!.page.getByTestId("kicked-banner")).toBeVisible();

    await bo!.page.reload();
    // Their token was revoked with the seat, so a reload lands on the start screen.
    await expect(bo!.page.getByTestId("name-input")).toBeVisible();
    await expect(bo!.page.getByTestId("room-code")).toHaveCount(0);

    for (const player of players) await player.close();
  });

  test("promotes a new host when the host leaves", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana, bo] = players;

    await ana!.page.getByTestId("leave-button").click();

    // Bo inherits the table, including the ability to start it.
    await expect(bo!.page.getByTestId("lobby-player-Ana")).toHaveCount(0);
    await expect(bo!.page.getByTestId("start-button")).toBeVisible();

    for (const player of players) await player.close();
  });

  test("lets the host pick the number of decks, and shows it to everyone", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana, bo] = players;

    // One deck to begin with, chosen for everyone.
    for (const player of players) {
      await expect(player.page.getByTestId("decks-1")).toHaveAttribute("aria-pressed", "true");
    }
    await expect(ana!.page.getByTestId("decks-hint")).toContainText("54 cards");

    await ana!.page.getByTestId("decks-3").click();

    for (const player of players) {
      await expect(player.page.getByTestId("decks-3")).toHaveAttribute("aria-pressed", "true");
      await expect(player.page.getByTestId("decks-1")).toHaveAttribute("aria-pressed", "false");
    }
    await expect(ana!.page.getByTestId("decks-hint")).toContainText("162 cards");

    // The choice is the host's alone.
    await expect(bo!.page.getByTestId("decks-2")).toBeDisabled();
    await expect(ana!.page.getByTestId("decks-2")).toBeEnabled();

    for (const player of players) await player.close();
  });

  test("lets the host pick the card back, and deals it to every screen", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana, bo] = players;

    await expect(ana!.page.getByTestId("back-navy-geometric")).toHaveAttribute("aria-pressed", "true");
    // The choice is the host's alone.
    await expect(bo!.page.getByTestId("back-red-grid")).toBeDisabled();
    await expect(ana!.page.getByTestId("back-red-grid")).toBeEnabled();

    await ana!.page.getByTestId("back-red-grid").click();

    for (const player of players) {
      await expect(player.page.getByTestId("back-red-grid")).toHaveAttribute("aria-pressed", "true");
      await expect(player.page.getByTestId("back-navy-geometric")).toHaveAttribute("aria-pressed", "false");
    }

    // ...and it is the back the cards actually wear once they are dealt.
    await ana!.page.getByTestId("start-button").click();
    for (const player of players) {
      await expect(player.page.getByTestId("ready-button")).toBeVisible();
      const back = await player.slot(0).evaluate((card) => {
        const art = card.querySelector(".card__art");
        return art === null ? "" : getComputedStyle(art).backgroundImage;
      });
      expect(back).toContain("/backs/red-grid.svg");
    }

    for (const player of players) await player.close();
  });

  test("starts the round for everyone at once", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    await players[0]!.page.getByTestId("start-button").click();

    for (const player of players) {
      await expect(player.page.getByTestId("prompt")).toContainText(/look at your two bottom cards/i);
      await expect(player.page.getByTestId("deck")).toBeVisible();
      // Four cards each, all face down.
      for (let slot = 0; slot < 4; slot++) {
        await expect(player.slot(slot)).toBeVisible();
      }
    }
    for (const player of players) await player.close();
  });

  test("lets each player study the bottom two cards and no more", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana] = players;
    await ana!.page.getByTestId("start-button").click();
    await expect(ana!.page.getByTestId("ready-button")).toBeVisible();

    // The top row is not offered at all - only the bottom two are clickable.
    await expect(ana!.slot(0)).not.toHaveClass(/card--targetable/);
    await expect(ana!.slot(1)).not.toHaveClass(/card--targetable/);
    await expect(ana!.slot(2)).toHaveClass(/card--targetable/);

    await ana!.slot(2).click();
    await ana!.slot(3).click();

    // Both are spent, so neither is offered any more.
    await expect(ana!.slot(2)).not.toHaveClass(/card--targetable/);
    await expect(ana!.slot(3)).not.toHaveClass(/card--targetable/);

    for (const player of players) await player.close();
  });

  test("waits for every player to be ready before play begins", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana, bo] = players;
    await ana!.page.getByTestId("start-button").click();

    await expect(ana!.page.getByTestId("ready-button")).toBeVisible();
    await ana!.page.getByTestId("ready-button").click();
    await expect(ana!.page.getByTestId("prompt")).toContainText(/waiting for the others/i);

    await expect(bo!.page.getByTestId("ready-button")).toBeVisible();
    await bo!.page.getByTestId("ready-button").click();

    await expect(ana!.page.getByTestId("prompt")).toContainText(/your turn/i);
    await expect(bo!.page.getByTestId("prompt")).toContainText(/ana's turn/i);

    for (const player of players) await player.close();
  });
});

test.describe("refreshing the page", () => {
  test("keeps the player in the lobby", async ({ browser }) => {
    const { players, code } = await seatTable(browser, ["Ana", "Bo"]);
    const [, bo] = players;

    await bo!.page.reload();

    await expect(bo!.page.getByTestId("room-code")).toContainText(code);
    await expect(bo!.page.getByTestId("lobby-player-Ana")).toBeVisible();
    await expect(bo!.page.getByTestId("lobby-player-Bo")).toBeVisible();

    for (const player of players) await player.close();
  });

  test("keeps the player at the table mid-game", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana, bo] = players;
    await startRound(players);

    const before = await bo!.page.getByTestId("deck-count").innerText();

    await bo!.page.reload();

    // Back in the same seat, looking at the same board.
    await expect(bo!.page.getByTestId("deck")).toBeVisible();
    await expect(bo!.page.getByTestId("deck-count")).toHaveText(before);
    await expect(bo!.page.getByTestId("seat-Bo")).toBeVisible();
    await expect(bo!.page.getByTestId("prompt")).toContainText(/ana's turn/i);

    // And still cannot see anyone's cards.
    await expect(bo!.page.locator(".card--up")).toHaveCount(1); // the discard top only

    for (const player of players) await player.close();
  });

  test("shows a player as away while they are gone", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana, bo] = players;
    await startRound(players);

    await bo!.page.close();

    await expect(ana!.page.getByTestId("away-Bo")).toBeVisible();

    for (const player of players) await player.close();
  });
});
