import { WebSocket } from "ws";
import type { Action, ClientMsg, GameView, ServerEvent } from "@cambio/shared";
import { startServer, type RunningServer, type StartOptions } from "../../src/server.js";
import { mulberry32 } from "../../src/rng.js";

/**
 * A scripted test client over a real WebSocket.
 *
 * It records every event it receives so assertions can be made about what one
 * player was actually told - which is how the hidden-information guarantees are
 * verified rather than assumed.
 */
export class TestClient {
  readonly received: ServerEvent[] = [];
  playerId = "";
  token = "";
  code = "";
  /**
   * Hold back the reply to a latency probe, so the server measures this client
   * as being further away than it is. That is how a real latency difference is
   * simulated end to end without touching the network.
   */
  pongDelayMs = 0;

  private readonly socket: WebSocket;
  private readonly waiters: { match: (e: ServerEvent) => boolean; resolve: (e: ServerEvent) => void }[] = [];
  /**
   * How far through `received` the discrete-event waiters have consumed.
   * Without this, waiting for an event that has *already* arrived hangs forever,
   * while rescanning from zero would match the same event twice.
   */
  private cursor = 0;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as ServerEvent;
      this.received.push(event);

      // Keep identity fresh, and answer latency probes like the real client.
      if (event.t === "hello") {
        this.playerId = event.playerId;
        this.token = event.token;
        this.code = event.code;
      }
      if (event.t === "ping") {
        if (this.pongDelayMs > 0) {
          setTimeout(() => this.send({ t: "pong", nonce: event.nonce }), this.pongDelayMs);
        } else {
          this.send({ t: "pong", nonce: event.nonce });
        }
      }

      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const waiter = this.waiters[i];
        if (waiter && waiter.match(event)) {
          this.waiters.splice(i, 1);
          waiter.resolve(event);
        }
      }
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return new TestClient(socket);
  }

  send(msg: ClientMsg): void {
    this.socket.send(JSON.stringify(msg));
  }

  act(action: Action): void {
    this.send({ t: "act", action });
  }

  /**
   * Wait for one occurrence of an event type, counting events that have already
   * arrived but not yet been consumed by an earlier call.
   */
  next<T extends ServerEvent["t"]>(type: T, timeoutMs = 2_000): Promise<Extract<ServerEvent, { t: T }>> {
    return this.waitFor((e): e is Extract<ServerEvent, { t: T }> => e.t === type, timeoutMs);
  }

  waitFor<T extends ServerEvent>(match: (e: ServerEvent) => e is T, timeoutMs = 2_000): Promise<T> {
    for (let i = this.cursor; i < this.received.length; i++) {
      const event = this.received[i];
      if (event && match(event)) {
        this.cursor = i + 1;
        return Promise.resolve(event);
      }
    }
    return this.waitForFuture(match, timeoutMs);
  }

  /** Wait only for something that has not happened yet. */
  private waitForFuture<T extends ServerEvent>(match: (e: ServerEvent) => e is T, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for an event; saw: ${this.received.map((e) => e.t).join(", ")}`));
      }, timeoutMs);

      this.waiters.push({
        match,
        resolve: (event) => {
          clearTimeout(timer);
          this.cursor = this.received.length;
          resolve(event as T);
        },
      });
    });
  }

  /**
   * Wait until the player's own view satisfies a condition.
   *
   * State is current truth rather than a discrete occurrence, so this checks the
   * newest view and then only future ones. Scanning the whole history here would
   * happily match a view the server has long since moved past.
   */
  async waitForState(predicate: (view: GameView) => boolean, timeoutMs = 2_000): Promise<GameView> {
    const existing = this.latestState();
    if (existing && predicate(existing)) return existing;

    const event = await this.waitForFuture(
      (e): e is Extract<ServerEvent, { t: "game.state" }> => e.t === "game.state" && predicate(e.view),
      timeoutMs,
    );
    return event.view;
  }

  latestState(): GameView | null {
    for (let i = this.received.length - 1; i >= 0; i--) {
      const event = this.received[i];
      if (event?.t === "game.state") return event.view;
    }
    return null;
  }

  /** Every state view this client was ever sent. Used by the leak assertion. */
  allStates(): GameView[] {
    return this.received.flatMap((e) => (e.t === "game.state" ? [e.view] : []));
  }

  eventsOfType<T extends ServerEvent["t"]>(type: T): Extract<ServerEvent, { t: T }>[] {
    return this.received.filter((e): e is Extract<ServerEvent, { t: T }> => e.t === type);
  }

  clear(): void {
    this.received.length = 0;
    this.cursor = 0;
  }

  close(): Promise<void> {
    if (this.socket.readyState === this.socket.CLOSED) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close();
    });
  }

  /** Drop the connection without a close frame, as a crashed tab would. */
  kill(): void {
    this.socket.terminate();
  }
}

export type Harness = {
  server: RunningServer;
  connect: () => Promise<TestClient>;
  /** Seat `names` at one table and return their clients, host first. */
  table: (names: string[]) => Promise<{ clients: TestClient[]; code: string }>;
  close: () => Promise<void>;
};

export async function harness(options: StartOptions = {}): Promise<Harness> {
  const server = await startServer({
    rng: mulberry32(1234),
    clientDist: null,
    pingIntervalMs: null,
    reapIntervalMs: null,
    // The turn clock would otherwise auto-play while a test is mid-assertion.
    rules: { turnMs: 0, ...options.rules },
    ...options,
  });

  const clients: TestClient[] = [];

  const connect = async (): Promise<TestClient> => {
    const client = await TestClient.connect(server.url);
    clients.push(client);
    return client;
  };

  return {
    server,
    connect,
    table: async (names) => {
      const [hostName, ...rest] = names;
      if (hostName === undefined) throw new Error("a table needs at least one player");

      const host = await connect();
      host.send({ t: "room.create", name: hostName });
      const hello = await host.next("hello");

      const joined: TestClient[] = [host];
      for (const name of rest) {
        const client = await connect();
        client.send({ t: "room.join", code: hello.code, name });
        await client.next("hello");
        joined.push(client);
      }
      // EVERY client must see the full table before a test starts asserting.
      // Waiting only on the host leaves the others holding a stale view, which
      // a later waitForState would match immediately and silently.
      await Promise.all(joined.map((c) => c.waitForState((v) => v.players.length === names.length)));
      return { clients: joined, code: hello.code };
    },
    close: async () => {
      await Promise.all(clients.map((c) => c.close()));
      await server.close();
    },
  };
}

/**
 * Wait until every client agrees on the table state, and return it.
 *
 * Clients receive their broadcasts independently, so reading one client's
 * latest view can pick up a state the server has already moved past. Anything
 * that decides what to do next must work from a converged view, or it ends up
 * addressing the wrong player. Doubles as a consistency check: all seats must
 * see the same phase, turn, and pile counts.
 */
export async function settled(clients: TestClient[], timeoutMs = 2_000): Promise<GameView> {
  return settledAfter(clients, -1, timeoutMs);
}

/**
 * Like `settled`, but also insists the state has moved past `minVersion`.
 *
 * Agreement alone is not enough: right after an action every client may still
 * agree on the state from *before* it, and acting on that view addresses the
 * wrong player. Gating on the version is what makes "wait for my action to land"
 * actually mean that.
 */
export async function settledAfter(
  clients: TestClient[],
  minVersion: number,
  timeoutMs = 2_000,
): Promise<GameView> {
  const deadline = Date.now() + timeoutMs;
  let last = "";

  while (Date.now() < deadline) {
    const views = clients.map((c) => c.latestState());
    const fingerprints = views.map((v) => (v === null ? "none" : `v${v.version}|${v.phase}|${v.turnPlayerId}`));
    last = fingerprints.join(" vs ");

    const first = views[0];
    if (first !== null && first.version > minVersion && new Set(fingerprints).size === 1) {
      // Agreement on the fingerprint implies agreement on the piles too.
      for (const view of views) {
        if (view === null) break;
        if (view.deckCount !== first.deckCount || view.discardCount !== first.discardCount) {
          throw new Error(`clients disagree on the piles at version ${first.version}`);
        }
      }
      return first;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`clients never agreed on a state past v${minVersion}: ${last}`);
}

/** Drive a table from the study phase into play. */
export async function startGame(clients: TestClient[]): Promise<void> {
  const host = clients[0];
  if (!host) throw new Error("no host");

  host.send({ t: "lobby.start" });
  await Promise.all(clients.map((c) => c.waitForState((v) => v.phase === "study")));

  for (const client of clients) client.act({ a: "readyUp" });
  await Promise.all(clients.map((c) => c.waitForState((v) => v.phase !== "study")));
}
