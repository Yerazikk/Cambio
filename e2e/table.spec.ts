import { expect, test, type Page } from "@playwright/test";
import { currentPlayer, seatTable, startRound, type Player } from "./fixtures.js";

/**
 * Watch for a class to appear on an element, starting before the move that
 * causes it. The move animations are deliberately short-lived, so polling
 * after the fact would be racing them.
 */
function waitForClass(page: Page, testId: string, className: string): Promise<unknown> {
  return page.waitForFunction(
    ([id, cls]) => document.querySelector(`[data-testid="${id}"]`)?.className.includes(cls as string) ?? false,
    [testId, className],
    { polling: 25, timeout: 10_000 },
  );
}

const log = (player: Player) => player.page.getByTestId("table-log");

test.describe("seating", () => {
  test("puts every player in their own bottom seat, with the rest round the table", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo", "Cy", "Di"]);
    await startRound(players);
    const [ana, bo, cy] = players;

    // Each player faces their own hand from the bottom of the table...
    for (const player of players) {
      await expect(player.page.getByTestId(`seat-${player.name}`)).toHaveClass(/seat--you/);
      await expect(player.page.getByTestId(`seat-${player.name}`)).toHaveClass(/seat--bottom/);
    }

    // ...and the others keep the order they sit in, so the player who plays
    // after you is on your left and the table runs clockwise from there.
    await expect(ana!.page.getByTestId("seat-Bo")).toHaveClass(/seat--left/);
    await expect(ana!.page.getByTestId("seat-Cy")).toHaveClass(/seat--top/);
    await expect(ana!.page.getByTestId("seat-Di")).toHaveClass(/seat--right/);

    // The same four people, seen from one seat further round.
    await expect(bo!.page.getByTestId("seat-Cy")).toHaveClass(/seat--left/);
    await expect(bo!.page.getByTestId("seat-Ana")).toHaveClass(/seat--right/);
    await expect(cy!.page.getByTestId("seat-Ana")).toHaveClass(/seat--top/);

    for (const player of players) await player.close();
  });
});

test.describe("watching the other players", () => {
  test("shows a drawn card sitting at the drawer's seat, face down to everyone else", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    await startRound(players);
    const actor = await currentPlayer(players);
    const other = players.find((p) => p !== actor)!;

    await actor.page.getByTestId("deck").click();

    // The drawer sees the face; the table sees only that a card is in hand.
    await expect(actor.page.getByTestId("held-card").locator(".card--up")).toHaveCount(1);
    const marker = other.page.getByTestId(`held-${actor.name}`);
    await expect(marker).toBeVisible();
    await expect(marker.locator(".card--down")).toHaveCount(1);
    await expect(other.page.getByTestId(`seat-${actor.name}`)).toHaveClass(/seat--holding/);

    // And it is gone from both screens once it goes into the hand.
    await actor.slot(0).click();
    await expect(other.page.getByTestId(`held-${actor.name}`)).toHaveCount(0);

    for (const player of players) await player.close();
  });

  test("shows a card taken off the discard pile to the whole table", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    await startRound(players);
    const actor = await currentPlayer(players);
    const other = players.find((p) => p !== actor)!;

    const top = await actor.page.getByTestId("discard").innerText();
    await actor.page.getByTestId("discard").click();

    // It was face up on the pile a moment ago, so everyone can still read it.
    const marker = other.page.getByTestId(`held-${actor.name}`);
    await expect(marker.locator(".card--up")).toHaveCount(1);
    await expect(marker).toContainText(top.trim().split("\n")[0]!);

    for (const player of players) await player.close();
  });

  test("flashes the card someone looks at on every screen, without showing its face", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana, bo] = players;
    await ana!.page.getByTestId("start-button").click();
    await expect(ana!.page.getByTestId("ready-button")).toBeVisible();

    const seen = waitForClass(bo!.page, "slot-Ana-2", "card--did-peek");
    await ana!.slot(2).click();
    await seen;

    // Bo saw which card was picked up, and is told so in words - but the card
    // itself never turned over on their screen.
    await expect(log(bo!)).toContainText("Ana looks at their own card");
    await expect(bo!.slotOf("Ana", 2)).not.toHaveClass(/card--up/);

    for (const player of players) await player.close();
  });

  test("flashes both ends of a swap, and names them in the log", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    await startRound(players);
    const actor = await currentPlayer(players);
    const other = players.find((p) => p !== actor)!;

    // Drawing and swapping is the one move always available; it replaces one
    // card in the actor's hand and sends the old one to the pile.
    await actor.page.getByTestId("deck").click();
    const landed = waitForClass(other.page, `slot-${actor.name}-1`, "card--did-replace");
    await actor.slot(1).click();
    await landed;

    await expect(log(other)).toContainText(`${actor.name} swaps it into their hand`);
    // And the same move reads as yours on your own screen.
    await expect(log(actor)).toContainText("You swap it into your hand");

    for (const player of players) await player.close();
  });
});
