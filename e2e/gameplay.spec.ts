import { expect, test } from "@playwright/test";
import { callCambio, currentPlayer, playSafeTurn, seatTable, startRound } from "./fixtures.js";

test.describe("playing by clicking", () => {
  test("draws a card and swaps it into a chosen slot", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    await startRound(players);
    const actor = await currentPlayer(players);
    const other = players.find((p) => p !== actor)!;

    const deckBefore = Number(await actor.page.getByTestId("deck-count").innerText());

    await actor.page.getByTestId("deck").click();
    await expect(actor.page.getByTestId("held-card")).toBeVisible();
    await expect(actor.page.getByTestId("prompt")).toContainText(/swap it into your hand/i);
    // The drawn card is visible to the drawer only.
    await expect(other.page.getByTestId("held-card")).toHaveCount(0);

    await actor.slot(2).click();

    await expect(actor.page.getByTestId("held-card")).toHaveCount(0);
    await expect(actor.page.getByTestId("deck-count")).toHaveText(String(deckBefore - 1));
    // The turn moved on.
    await expect(actor.page.getByTestId("prompt")).not.toContainText(/your turn/i);

    for (const player of players) await player.close();
  });

  test("discards a drawn card instead of keeping it", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    await startRound(players);
    const actor = await currentPlayer(players);

    await actor.page.getByTestId("deck").click();
    await expect(actor.page.getByTestId("discard-drawn")).toBeVisible();
    const discardBefore = Number(await actor.page.getByTestId("discard-count").innerText());

    await actor.page.getByTestId("discard-drawn").click();

    await expect(actor.page.getByTestId("discard-count")).toHaveText(String(discardBefore + 1));

    for (const player of players) await player.close();
  });

  test("refuses to let a player act out of turn", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    await startRound(players);
    const actor = await currentPlayer(players);
    const waiting = players.find((p) => p !== actor)!;

    // The deck is not even clickable for the player without the turn.
    await expect(waiting.page.getByTestId("deck")).not.toHaveClass(/card--targetable/);
    await expect(waiting.page.getByTestId("cambio-button")).toHaveCount(0);

    for (const player of players) await player.close();
  });

  test("keeps both players' boards in step", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana, bo] = players;
    await startRound(players);

    await playSafeTurn(players);
    await playSafeTurn(players);

    const anaDeck = await ana!.page.getByTestId("deck-count").innerText();
    const boDeck = await bo!.page.getByTestId("deck-count").innerText();
    expect(anaDeck).toBe(boDeck);

    const anaDiscard = await ana!.page.getByTestId("discard-count").innerText();
    const boDiscard = await bo!.page.getByTestId("discard-count").innerText();
    expect(anaDiscard).toBe(boDiscard);

    for (const player of players) await player.close();
  });

  test("hides every hand from everyone during play", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    await startRound(players);
    await playSafeTurn(players);

    for (const player of players) {
      // Only the discard top is ever face up on the table.
      await expect(player.page.getByTestId("seat-Ana").locator(".card--up")).toHaveCount(0);
      await expect(player.page.getByTestId("seat-Bo").locator(".card--up")).toHaveCount(0);
    }
    for (const player of players) await player.close();
  });

  test("flips a studied card up and then back down again", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana] = players;
    await ana!.page.getByTestId("start-button").click();
    await expect(ana!.page.getByTestId("ready-button")).toBeVisible();

    await ana!.slot(2).click();
    // The peek is shown to this player...
    await expect(ana!.slot(2)).toHaveClass(/card--up/);
    // ...and then taken away again, because remembering it is the game.
    await expect(ana!.slot(2)).not.toHaveClass(/card--up/, { timeout: 15_000 });

    for (const player of players) await player.close();
  });
});

test.describe("calling Cambio", () => {
  test("ends the round and shows everyone the same result", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    await startRound(players);

    await playSafeTurn(players);

    await callCambio(players);

    // Everyone else gets one last turn, then the round settles.
    for (let turn = 0; turn < 3; turn++) {
      const over = await players[0]!.page.getByTestId("game-over").count();
      if (over > 0) break;
      await playSafeTurn(players);
    }

    for (const player of players) {
      await expect(player.page.getByTestId("game-over")).toBeVisible();
      // Final hands are revealed and scored for both seats.
      await expect(player.page.getByTestId("final-Ana")).toBeVisible();
      await expect(player.page.getByTestId("final-Bo")).toBeVisible();
    }

    const anaResult = await players[0]!.page.getByTestId("game-over").innerText();
    const boResult = await players[1]!.page.getByTestId("game-over").innerText();
    // Both see the same scores, even though the winner line is phrased per player.
    expect(anaResult.match(/-?\d+/g)).toEqual(boResult.match(/-?\d+/g));

    for (const player of players) await player.close();
  });

  test("hides the Cambio button once it has been called", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo", "Cy"]);
    await startRound(players);

    await callCambio(players);

    const next = await currentPlayer(players);
    await expect(next.page.getByTestId("cambio-button")).toHaveCount(0);
    await expect(next.page.getByTestId("prompt")).toContainText(/your turn/i);

    for (const player of players) await player.close();
  });

  test("plays another round for the whole table from the result screen", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana, bo] = players;
    await startRound(players);

    await callCambio(players);
    for (let turn = 0; turn < 3; turn++) {
      if ((await ana!.page.getByTestId("game-over").count()) > 0) break;
      await playSafeTurn(players);
    }

    // Only the host can play again; the others are told to wait.
    await expect(ana!.page.getByTestId("play-again")).toBeVisible();
    await expect(bo!.page.getByTestId("play-again")).toHaveCount(0);
    await expect(bo!.page.getByTestId("over-waiting")).toBeVisible();

    await ana!.page.getByTestId("play-again").click();

    // Both players land back in the study phase with a fresh hand.
    for (const player of players) {
      await expect(player.page.getByTestId("game-over")).toHaveCount(0);
      await expect(player.page.getByTestId("ready-button")).toBeVisible();
      await expect(player.page.getByTestId("prompt")).toContainText(/look at your two bottom cards/i);
    }

    for (const player of players) await player.close();
  });

  test("returns to the start screen from the result", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    await startRound(players);

    await callCambio(players);
    for (let turn = 0; turn < 3; turn++) {
      if ((await players[0]!.page.getByTestId("game-over").count()) > 0) break;
      await playSafeTurn(players);
    }

    await players[0]!.page.getByTestId("over-leave").click();
    await expect(players[0]!.page.getByTestId("name-input")).toBeVisible();

    for (const player of players) await player.close();
  });
});
