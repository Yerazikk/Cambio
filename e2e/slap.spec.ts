import { expect, test, type Page } from "@playwright/test";
import { seatTable, startRound, type Player } from "./fixtures.js";

/** Collect every toast a page has shown. */
async function toasts(page: Page): Promise<string[]> {
  return page.getByTestId("toast").allInnerTexts();
}

/** A toast about a slap, in any of the forms the table can report one. */
const SLAP_LINE = /slapped|got there first|slap was too late/i;
/** A slap that never had to be played, because the one ahead of it was right. */
const SPARED_LINE = /your slap was not played|your slap was too late/i;

type RaceReport = {
  /** The slaps that were actually played out, as the whole table was told them. */
  played: string[];
  /** Players whose slap was spared because someone ahead of them was right. */
  spared: string[];
};

/**
 * Read a settled race off the players' screens.
 *
 * Every slap that is played out is broadcast, so each screen must carry the
 * same account of the race in the same order - "You slapped" on your own
 * screen being the same event as "Ana slapped" on everyone else's. Only the
 * private line telling you that you were spared differs between screens.
 *
 * The guarantee being checked is the one that matters to players: slapping at
 * the same moment as somebody else does not throw your slap away. Every player
 * who slapped is either in the public account or was spared by a right slap
 * ahead of them - never silently dropped.
 */
async function raceOutcome(players: Player[]): Promise<RaceReport> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const seen = await Promise.all(
      players.map(async (p) => ({
        name: p.name,
        // Normalise the viewer's own name so the screens can be compared.
        lines: (await toasts(p.page)).filter((l) => SLAP_LINE.test(l)).map((l) => l.replace(/^You\b/, p.name)),
      })),
    );

    const public_ = seen.map((s) => s.lines.filter((l) => !SPARED_LINE.test(l)));
    const spared = seen.filter((s) => s.lines.some((l) => SPARED_LINE.test(l))).map((s) => s.name);
    const played = public_[0] ?? [];

    const agreed = public_.every((lines) => lines.join("|") === played.join("|"));
    const accounted = players.every((p) => played.some((l) => l.startsWith(p.name)) || spared.includes(p.name));

    if (agreed && played.length > 0 && accounted) return { played, spared };
    await players[0]!.page.waitForTimeout(100);
  }

  const dump = await Promise.all(players.map(async (p) => `${p.name}: ${(await toasts(p.page)).join(" / ")}`));
  throw new Error(`the race never resolved consistently: ${dump.join(" | ")}`);
}

test.describe("slapping", () => {
  test("is closed until the round is under way", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    await players[0]!.page.getByTestId("start-button").click();
    await expect(players[0]!.page.getByTestId("slap-button")).toBeDisabled();

    for (const player of players) await player.close();
  });

  test("opens once play begins", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    await startRound(players);

    await expect(players[0]!.page.getByTestId("slap-button")).toBeEnabled();
    await expect(players[0]!.page.getByTestId("slap-button")).toHaveText("SLAP");

    for (const player of players) await player.close();
  });

  test("arms with the button and marks every card as a target", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana] = players;
    await startRound(players);

    await ana!.page.getByTestId("slap-button").click();

    await expect(ana!.page.getByTestId("slap-button")).toHaveText(/pick a card/i);
    await expect(ana!.slot(0)).toHaveClass(/card--slap/);
    // An opponent's cards are slappable too, which is how you take one off them.
    await expect(ana!.slotOf("Bo", 0)).toHaveClass(/card--slap/);

    for (const player of players) await player.close();
  });

  test("arms with the S key and cancels with Escape", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana] = players;
    await startRound(players);

    await ana!.page.keyboard.press("s");
    await expect(ana!.slot(0)).toHaveClass(/card--slap/);

    await ana!.page.keyboard.press("Escape");
    await expect(ana!.slot(0)).not.toHaveClass(/card--slap/);

    for (const player of players) await player.close();
  });

  test("resolves a slap made by clicking a card", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana] = players;
    await startRound(players);

    await ana!.page.getByTestId("slap-button").click();
    await ana!.slot(0).click();

    // Right or wrong, the slap resolves and the player is told what happened.
    await expect(ana!.page.getByTestId("toast")).toContainText(/You slapped/);
    // Slap mode disarms itself once resolved.
    await expect(ana!.page.getByTestId("slap-button")).toHaveText("SLAP");

    for (const player of players) await player.close();
  });

  test("slaps your own card straight from the number keys", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana] = players;
    await startRound(players);

    // The fast path: no arming click, because milliseconds decide the race.
    await ana!.page.keyboard.press("1");

    await expect(ana!.page.getByTestId("toast")).toContainText(/You slapped/);

    for (const player of players) await player.close();
  });
});

test.describe("racing a slap between two browsers", () => {
  test("plays out every slap instead of cancelling the slower one", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana, bo] = players;
    await startRound(players);

    // Both fire at essentially the same moment, from separate browsers.
    await Promise.all([ana!.page.keyboard.press("1"), bo!.page.keyboard.press("1")]);

    const outcome = await raceOutcome(players);
    // Nobody is dropped: each player either had their slap played out, or was
    // spared by a right slap ahead of them in the queue.
    expect(outcome.played.length + outcome.spared.length).toBe(players.length);
    // Being spared only happens behind a slap that was right.
    if (outcome.spared.length > 0) expect(outcome.played.some((l) => /slapped(?! wrong)/.test(l))).toBe(true);

    for (const player of players) await player.close();
  });

  test("agrees on the order even with one player on a throttled connection", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo"]);
    const [ana, bo] = players;
    await startRound(players);

    // Put Bo behind added latency. However the queue comes out, the table must
    // not disagree: the server decides once and tells everyone the same thing.
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
    expect(outcome.played.length + outcome.spared.length).toBe(players.length);

    await cdp.detach();
    for (const player of players) await player.close();
  });

  test("tells a three-player table one consistent result", async ({ browser }) => {
    const { players } = await seatTable(browser, ["Ana", "Bo", "Cy"]);
    await startRound(players);

    await Promise.all(players.map((p) => p.page.keyboard.press("1")));

    const outcome = await raceOutcome(players);
    expect(outcome.played.length + outcome.spared.length).toBe(3);

    for (const player of players) await player.close();
  });
});
