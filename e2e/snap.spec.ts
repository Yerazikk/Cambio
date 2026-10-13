import { expect, test, type Page } from "@playwright/test";
import { seatTable, startRound, type Player } from "./fixtures.js";

/** Collect every toast a page has shown. */
async function toasts(page: Page): Promise<string[]> {
  return page.getByTestId("toast").allInnerTexts();
}

/**
 * Read a resolved race off the players' screens.
 *
 * The winner's own screen says "You ...", and every loser is told "Too slow -
 * <name> got there first". Cross-checking those two is how the test verifies
 * that the whole table agreed on one winner, which is the guarantee that
 * actually matters to players.
 */
async function raceOutcome(players: Player[]): Promise<{ winner: string; losers: string[] }> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const seen = await Promise.all(players.map(async (p) => ({ player: p, lines: await toasts(p.page) })));

    const selfWinner = seen.find((s) => s.lines.some((line) => /^You snapped/.test(line)));
    const losers = seen.filter((s) => s.lines.some((line) => /Too slow/.test(line)));

    if (selfWinner && losers.length === players.length - 1) {
      // Every loser must name the same winner the winner's own screen implies.
      for (const loser of losers) {
        const line = loser.lines.find((l) => /Too slow/.test(l)) ?? "";
        const named = /Too slow - (.+?) got there first/.exec(line)?.[1]?.trim();
        expect(named, `${loser.player.name} was told a different winner`).toBe(selfWinner.player.name);
      }
      return { winner: selfWinner.player.name, losers: losers.map((l) => l.player.name) };
    }
    await players[0]!.page.waitForTimeout(100);
  }

  const dump = await Promise.all(players.map(async (p) => `${p.name}: ${(await toasts(p.page)).join(" / ")}`));
  throw new Error(`the race never resolved consistently: ${dump.join(" | ")}`);
}

test.describe("snapping", () => {
  test("is closed until the round is under way", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    await players[0]!.page.getByTestId("start-button").click();
    await expect(players[0]!.page.getByTestId("snap-button")).toBeDisabled();

    for (const player of players) await player.close();
  });

  test("opens once play begins", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    await startRound(players);

    await expect(players[0]!.page.getByTestId("snap-button")).toBeEnabled();
    await expect(players[0]!.page.getByTestId("snap-button")).toHaveText("SNAP");

    for (const player of players) await player.close();
  });

  test("arms with the button and marks every card as a target", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana] = players;
    await startRound(players);

    await ana!.page.getByTestId("snap-button").click();

    await expect(ana!.page.getByTestId("snap-button")).toHaveText(/pick a card/i);
    await expect(ana!.slot(0)).toHaveClass(/card--snap/);
    // An opponent's cards are snappable too, which is how you take one off them.
    await expect(ana!.slotOf("Bo", 0)).toHaveClass(/card--snap/);

    for (const player of players) await player.close();
  });

  test("arms with the S key and cancels with Escape", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana] = players;
    await startRound(players);

    await ana!.page.keyboard.press("s");
    await expect(ana!.slot(0)).toHaveClass(/card--snap/);

    await ana!.page.keyboard.press("Escape");
    await expect(ana!.slot(0)).not.toHaveClass(/card--snap/);

    for (const player of players) await player.close();
  });

  test("resolves a snap made by clicking a card", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana] = players;
    await startRound(players);

    await ana!.page.getByTestId("snap-button").click();
    await ana!.slot(0).click();

    // Right or wrong, the snap resolves and the player is told what happened.
    await expect(ana!.page.getByTestId("toast")).toContainText(/You snapped/);
    // Snap mode disarms itself once resolved.
    await expect(ana!.page.getByTestId("snap-button")).toHaveText("SNAP");

    for (const player of players) await player.close();
  });

  test("snaps your own card straight from the number keys", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana] = players;
    await startRound(players);

    // The fast path: no arming click, because milliseconds decide the race.
    await ana!.page.keyboard.press("1");

    await expect(ana!.page.getByTestId("toast")).toContainText(/You snapped/);

    for (const player of players) await player.close();
  });
});

test.describe("racing a snap between two browsers", () => {
  test("declares one winner that both players agree on", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana, bo] = players;
    await startRound(players);

    // Both fire at essentially the same moment, from separate browsers.
    await Promise.all([ana!.page.keyboard.press("1"), bo!.page.keyboard.press("1")]);

    const outcome = await raceOutcome(players);
    expect(["Ana", "Bo"]).toContain(outcome.winner);
    expect(outcome.losers).toHaveLength(1);

    for (const player of players) await player.close();
  });

  test("agrees on the winner even with one player on a throttled connection", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana, bo] = players;
    await startRound(players);

    // Put Bo behind added latency. Whoever wins, the table must not disagree:
    // the server decides once and tells everyone the same thing.
    const cdp = await bo!.context.newCDPSession(bo!.page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 120,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });

    await Promise.all([ana!.page.keyboard.press("1"), bo!.page.keyboard.press("1")]);

    const outcome = await raceOutcome(players);
    expect(["Ana", "Bo"]).toContain(outcome.winner);

    await cdp.detach();
    for (const player of players) await player.close();
  });

  test("tells a three-player table one consistent result", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo", "Cy"]);
    await startRound(players);

    await Promise.all(players.map((p) => p.page.keyboard.press("1")));

    const outcome = await raceOutcome(players);
    expect(outcome.losers).toHaveLength(2);

    for (const player of players) await player.close();
  });
});
