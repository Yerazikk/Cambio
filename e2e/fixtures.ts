import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * One player in their own browser context.
 *
 * A separate context per player is what makes this a real multiplayer test:
 * sessionStorage is per-context, so each one holds its own seat token exactly
 * as separate people on separate machines would.
 */
export class Player {
  constructor(
    readonly name: string,
    readonly context: BrowserContext,
    readonly page: Page,
  ) {}

  static async open(browser: Browser, name: string): Promise<Player> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByTestId("name-input")).toBeVisible();
    await page.getByTestId("name-input").fill(name);
    return new Player(name, context, page);
  }

  async createTable(): Promise<string> {
    await this.page.getByTestId("create-button").click();
    const code = await this.page.getByTestId("room-code").innerText();
    return code.split("\n")[0]!.trim();
  }

  async joinTable(code: string): Promise<void> {
    await this.page.getByTestId("code-input").fill(code);
    await this.page.getByTestId("join-button").click();
    await expect(this.page.getByTestId("room-code")).toBeVisible();
  }

  prompt(): Promise<string> {
    return this.page.getByTestId("prompt").innerText();
  }

  async isMyTurn(): Promise<boolean> {
    const text = await this.prompt();
    return text.startsWith("Your turn");
  }

  /** My own hand's slots, in order. */
  slot(index: number) {
    return this.page.getByTestId(`slot-${this.name}-${index}`);
  }

  slotOf(playerName: string, index: number) {
    return this.page.getByTestId(`slot-${playerName}-${index}`);
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

/** Seat a host plus guests at one table, and return them with the code. */
export async function seatTable(browser: Browser, names: string[]): Promise<{ players: Player[]; code: string }> {
  const [hostName, ...guestNames] = names;
  if (hostName === undefined) throw new Error("a table needs a host");

  const host = await Player.open(browser, hostName);
  const code = await host.createTable();

  const players = [host];
  for (const name of guestNames) {
    const guest = await Player.open(browser, name);
    await guest.joinTable(code);
    players.push(guest);
  }

  // Everyone must see the full table before a test starts clicking.
  for (const player of players) {
    for (const name of names) {
      await expect(player.page.getByTestId(`lobby-player-${name}`)).toBeVisible();
    }
  }
  return { players, code };
}

/** Start the round and get every player through the study phase. */
export async function startRound(players: Player[]): Promise<void> {
  const host = players[0];
  if (!host) throw new Error("no host");

  await host.page.getByTestId("start-button").click();

  for (const player of players) {
    await expect(player.page.getByTestId("ready-button")).toBeVisible();
    // Study two cards, which is what the rules allow.
    await player.slot(0).click();
    await player.slot(1).click();
    await player.page.getByTestId("ready-button").click();
  }

  for (const player of players) {
    await expect(player.page.getByTestId("ready-button")).toHaveCount(0);
  }
}

/**
 * Whoever the table is waiting on.
 *
 * Insists that exactly one player claims the turn. Right after an action the
 * previous player's screen can still say "Your turn" while the next player's
 * already does too, and picking the first match there returns the wrong player
 * and makes the next click fail.
 */
export async function currentPlayer(players: Player[]): Promise<Player> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const claiming: Player[] = [];
    for (const player of players) {
      if (await player.isMyTurn()) claiming.push(player);
    }
    if (claiming.length === 1) return claiming[0]!;
    await players[0]!.page.waitForTimeout(100);
  }
  const prompts = await Promise.all(players.map(async (p) => `${p.name}: ${await p.prompt()}`));
  throw new Error(`the table never settled on one player's turn: ${prompts.join(" | ")}`);
}

/** Call Cambio and wait for the turn to actually move off the caller. */
export async function callCambio(players: Player[]): Promise<Player> {
  const caller = await currentPlayer(players);
  await caller.page.getByTestId("cambio-button").click();
  await expect(caller.page.getByTestId("prompt")).toContainText(/final turns|round over/i);
  return caller;
}

/**
 * Play one turn by drawing and swapping into slot 0.
 *
 * Swapping always ends the turn cleanly, where discarding can trigger a power
 * and leave the table mid-decision. That keeps the driver deterministic without
 * weakening what is being tested: the powers have their own coverage.
 */
export async function playSafeTurn(players: Player[]): Promise<void> {
  const actor = await currentPlayer(players);
  await actor.page.getByTestId("deck").click();
  await expect(actor.page.getByTestId("held-card")).toBeVisible();
  await actor.slot(0).click();
  await expect(actor.page.getByTestId("held-card")).toHaveCount(0);
}
