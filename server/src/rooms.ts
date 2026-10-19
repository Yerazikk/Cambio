import {
  DEFAULT_RULES,
  isCardBack,
  MAX_DECKS,
  MAX_PLAYERS,
  MIN_DECKS,
  MIN_PLAYERS,
  RECONNECT_GRACE_IN_GAME_MS,
  RECONNECT_GRACE_LOBBY_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_REAP_IDLE_MS,
  type Action,
  type ErrorCode,
  type PlayerId,
  type RoomCode,
  type RuleConfig,
} from "@cambio/shared";
import { reduce, type Outbound, type ReduceCtx } from "./engine/reduce.js";
import { addSeat, emptyState, startRound } from "./engine/setup.js";
import { seatOf, snapOpen, viewFor, type GameState } from "./engine/state.js";
import type { Rng } from "./rng.js";
import { RttTracker } from "./rtt.js";
import { SnapArbiter, realScheduler, type Scheduler, type SnapRace } from "./snap.js";

export type Session = { token: string; playerId: PlayerId; code: RoomCode };

export type Room = {
  code: RoomCode;
  state: GameState;
  arbiter: SnapArbiter;
  rtt: RttTracker;
  /** Seats whose player has dropped but whose grace period is still running. */
  graceHandles: Map<PlayerId, unknown>;
  turnHandle: unknown;
  lastActivityAt: number;
};

export type Ok<T> = { ok: true } & T;
export type Err = { ok: false; code: ErrorCode; message: string };
export type Result<T> = Ok<T> | Err;

function err(code: ErrorCode, message: string): Err {
  return { ok: false, code, message };
}

export type RoomManagerOptions = {
  now: () => number;
  rng: Rng;
  /** Injected so tests get stable ids instead of nanoids. */
  newId?: () => string;
  scheduler?: Scheduler;
  rules?: Partial<RuleConfig>;
  /** Override how long a dropped player's seat is held. Tests shorten this. */
  graceMs?: { inGame?: number; lobby?: number };
  /**
   * Output produced by a timer rather than by a client message: a settled snap
   * race, an expired grace period, a turn that ran out of clock.
   */
  onAsync?: (code: RoomCode, out: Outbound[]) => void;
};

/**
 * Owns every room, every session token, and the timers that go with them.
 *
 * All game rules live in the reducer; this layer is about identity and
 * lifecycle - who holds which seat, what survives a refresh, and when a
 * dropped player's seat is finally given up.
 */
export class RoomManager {
  private readonly rooms = new Map<RoomCode, Room>();
  private readonly sessions = new Map<string, Session>();
  private readonly scheduler: Scheduler;
  private idCounter = 0;

  constructor(private readonly opts: RoomManagerOptions) {
    this.scheduler = opts.scheduler ?? realScheduler;
  }

  private get rules(): RuleConfig {
    return { ...DEFAULT_RULES, ...this.opts.rules };
  }

  private nextId(): string {
    return this.opts.newId ? this.opts.newId() : `id${++this.idCounter}`;
  }

  private ctx(): ReduceCtx {
    return { now: this.opts.now(), rng: this.opts.rng };
  }

  /**
   * Hand timer-driven output to the transport. Always fires, even with nothing
   * to say, because the transport rebroadcasts personalized state on every
   * wake-up and a vacated seat changes that state with no event of its own.
   */
  private emitAsync(code: RoomCode, out: Outbound[]): void {
    this.opts.onAsync?.(code, out);
  }

  /* ----------------------------------------------------------- inspection */

  getRoom(code: RoomCode): Room | undefined {
    return this.rooms.get(code);
  }

  sessionFor(token: string): Session | undefined {
    return this.sessions.get(token);
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  /** The personalized payload for one player. Every send goes through this. */
  stateView(code: RoomCode, playerId: PlayerId) {
    const room = this.rooms.get(code);
    return room ? viewFor(room.state, playerId) : null;
  }

  /** Who should currently receive broadcasts for this room. */
  membersOf(code: RoomCode): PlayerId[] {
    return this.rooms.get(code)?.state.seats.map((s) => s.id) ?? [];
  }

  /* -------------------------------------------------------------- codes */

  private freshCode(): RoomCode {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = "";
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        const index = Math.floor(this.opts.rng() * ROOM_CODE_ALPHABET.length);
        code += ROOM_CODE_ALPHABET[index] ?? "A";
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new Error("could not allocate an unused room code");
  }

  /* --------------------------------------------------------- membership */

  createRoom(name: string): Ok<{ code: RoomCode; playerId: PlayerId; token: string }> {
    const code = this.freshCode();
    const playerId = this.nextId();
    const token = this.nextId();

    let state = emptyState(code, playerId, this.rules);
    state = addSeat(state, { id: playerId, name: cleanName(name, playerId) });

    const room: Room = {
      code,
      state,
      rtt: new RttTracker(this.opts.now),
      arbiter: new SnapArbiter({
        windowMs: this.rules.snapWindowMs,
        now: this.opts.now,
        scheduler: this.scheduler,
        onResolve: (race) => this.onSnapRace(code, race),
      }),
      graceHandles: new Map(),
      turnHandle: null,
      lastActivityAt: this.opts.now(),
    };
    this.rooms.set(code, room);
    this.sessions.set(token, { token, playerId, code });

    return { ok: true, code, playerId, token };
  }

  joinRoom(code: RoomCode, name: string): Result<{ code: RoomCode; playerId: PlayerId; token: string }> {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) return err("roomNotFound", `no room with the code ${code}`);
    if (room.state.phase !== "lobby") return err("gameAlreadyStarted", "that game is already under way");
    if (room.state.seats.length >= MAX_PLAYERS) return err("roomFull", `that table is full (${MAX_PLAYERS} players)`);

    const wanted = cleanName(name, "player");
    if (room.state.seats.some((s) => s.name.toLowerCase() === wanted.toLowerCase())) {
      return err("nameTaken", `someone at that table is already called ${wanted}`);
    }

    const playerId = this.nextId();
    const token = this.nextId();
    room.state = addSeat(room.state, { id: playerId, name: wanted });
    room.lastActivityAt = this.opts.now();
    this.sessions.set(token, { token, playerId, code: room.code });

    return { ok: true, code: room.code, playerId, token };
  }

  /**
   * Reattach to a held seat after a refresh. The token is the only thing that
   * survives the page reload, and it is minted server-side.
   */
  resume(token: string): Result<{ code: RoomCode; playerId: PlayerId }> {
    const session = this.sessions.get(token);
    if (!session) return err("sessionInvalid", "that session is no longer valid");

    const room = this.rooms.get(session.code);
    if (!room) return err("roomNotFound", "that room no longer exists");

    const seat = seatOf(room.state, session.playerId);
    if (!seat) return err("sessionInvalid", "your seat has been given up");

    this.cancelGrace(room, session.playerId);
    seat.connected = true;
    room.state.version += 1;
    room.lastActivityAt = this.opts.now();

    return { ok: true, code: room.code, playerId: session.playerId };
  }

  /**
   * Mark a player as dropped and start their grace period. The seat is held so
   * a refresh does not cost them the game.
   */
  disconnect(code: RoomCode, playerId: PlayerId): void {
    const room = this.rooms.get(code);
    if (!room) return;
    const seat = seatOf(room.state, playerId);
    if (!seat) return;

    seat.connected = false;
    room.state.version += 1;
    room.rtt.forget(playerId);
    room.lastActivityAt = this.opts.now();

    const graceMs =
      room.state.phase === "lobby"
        ? (this.opts.graceMs?.lobby ?? RECONNECT_GRACE_LOBBY_MS)
        : (this.opts.graceMs?.inGame ?? RECONNECT_GRACE_IN_GAME_MS);
    this.cancelGrace(room, playerId);
    room.graceHandles.set(
      playerId,
      this.scheduler.setTimeout(() => this.vacateSeat(code, playerId), graceMs),
    );
  }

  /** Give up a seat for good, once its grace period has run out. */
  private vacateSeat(code: RoomCode, playerId: PlayerId): void {
    const room = this.rooms.get(code);
    if (!room) return;
    room.graceHandles.delete(playerId);

    const seat = seatOf(room.state, playerId);
    if (!seat || seat.connected) return;

    this.removeSeat(room, playerId);
    this.revokeSessionsFor(playerId);
    this.emitAsync(code, []);
  }

  private removeSeat(room: Room, playerId: PlayerId): void {
    const index = room.state.seats.findIndex((s) => s.id === playerId);
    if (index === -1) return;

    room.state.seats.splice(index, 1);
    room.state.version += 1;

    if (room.state.seats.length === 0) {
      this.closeRoom(room.code);
      return;
    }

    // Keep the turn pointing at the same player it was on.
    if (index < room.state.turnIndex) room.state.turnIndex -= 1;
    if (room.state.turnIndex >= room.state.seats.length) room.state.turnIndex = 0;

    // The host leaving promotes whoever is now first, so a table is never
    // stuck without someone able to start or kick.
    if (room.state.hostId === playerId) {
      const next = room.state.seats[0];
      if (next) room.state.hostId = next.id;
    }
  }

  private revokeSessionsFor(playerId: PlayerId): void {
    for (const [token, session] of this.sessions) {
      if (session.playerId === playerId) this.sessions.delete(token);
    }
  }

  private cancelGrace(room: Room, playerId: PlayerId): void {
    const handle = room.graceHandles.get(playerId);
    if (handle !== undefined) {
      this.scheduler.clearTimeout(handle);
      room.graceHandles.delete(playerId);
    }
  }

  /** Leave voluntarily: the seat goes immediately, with no grace period. */
  leave(code: RoomCode, playerId: PlayerId): void {
    const room = this.rooms.get(code);
    if (!room) return;
    this.cancelGrace(room, playerId);
    this.removeSeat(room, playerId);
    this.revokeSessionsFor(playerId);
  }

  kick(code: RoomCode, byPlayerId: PlayerId, targetId: PlayerId): Result<{ targetId: PlayerId }> {
    const room = this.rooms.get(code);
    if (!room) return err("roomNotFound", "that room no longer exists");
    if (room.state.hostId !== byPlayerId) return err("notHost", "only the host can remove players");
    if (targetId === byPlayerId) return err("illegalAction", "you cannot remove yourself; leave instead");
    if (!seatOf(room.state, targetId)) return err("badTarget", "that player is not at this table");

    this.cancelGrace(room, targetId);
    this.removeSeat(room, targetId);
    // Revoking the token is what stops a kicked player resuming straight back in.
    this.revokeSessionsFor(targetId);
    room.lastActivityAt = this.opts.now();

    return { ok: true, targetId };
  }

  /**
   * Choose how many packs the table plays with. Lobby only, so the deck cannot
   * change under a round that is already being played.
   */
  setDecks(code: RoomCode, byPlayerId: PlayerId, decks: number): Result<{ decks: number }> {
    const room = this.rooms.get(code);
    if (!room) return err("roomNotFound", "that room no longer exists");
    if (room.state.hostId !== byPlayerId) return err("notHost", "only the host can change the deck");
    if (room.state.phase !== "lobby") return err("illegalAction", "the deck is set before the round starts");
    if (!Number.isInteger(decks) || decks < MIN_DECKS || decks > MAX_DECKS) {
      return err("malformed", `pick between ${MIN_DECKS} and ${MAX_DECKS} decks`);
    }

    room.state.rules = { ...room.state.rules, decks };
    room.state.version += 1;
    room.lastActivityAt = this.opts.now();
    return { ok: true, decks };
  }

  /**
   * Choose the table's card back. Allowed at any point, unlike the deck count:
   * it changes nothing but how the cards look, so there is no round it could
   * unsettle.
   */
  setBack(code: RoomCode, byPlayerId: PlayerId, back: string): Result<{ back: string }> {
    const room = this.rooms.get(code);
    if (!room) return err("roomNotFound", "that room no longer exists");
    if (room.state.hostId !== byPlayerId) return err("notHost", "only the host can change the cards");
    if (!isCardBack(back)) return err("malformed", `there is no card back called ${back}`);

    room.state.back = back;
    room.state.version += 1;
    room.lastActivityAt = this.opts.now();
    return { ok: true, back };
  }

  start(code: RoomCode, byPlayerId: PlayerId): Result<{ out: Outbound[] }> {
    const room = this.rooms.get(code);
    if (!room) return err("roomNotFound", "that room no longer exists");
    if (room.state.hostId !== byPlayerId) return err("notHost", "only the host can start the game");
    if (room.state.phase !== "lobby") return err("gameAlreadyStarted", "that game is already under way");
    if (room.state.seats.length < MIN_PLAYERS) {
      return err("notEnoughPlayers", `you need at least ${MIN_PLAYERS} players`);
    }

    room.state = startRound(room.state, this.opts.rng);
    room.lastActivityAt = this.opts.now();
    return { ok: true, out: [] };
  }

  /**
   * Play another round at the same table. Keeps everyone in their seat, so a
   * group can keep playing without swapping room codes.
   */
  restart(code: RoomCode, byPlayerId: PlayerId): Result<{ out: Outbound[] }> {
    const room = this.rooms.get(code);
    if (!room) return err("roomNotFound", "that room no longer exists");
    if (room.state.hostId !== byPlayerId) return err("notHost", "only the host can start another round");
    if (room.state.phase !== "finished") return err("illegalAction", "finish this round first");
    if (room.state.seats.length < MIN_PLAYERS) {
      return err("notEnoughPlayers", `you need at least ${MIN_PLAYERS} players`);
    }

    room.arbiter.cancel();
    room.state = startRound(room.state, this.opts.rng);
    room.lastActivityAt = this.opts.now();
    return { ok: true, out: [] };
  }

  /* ------------------------------------------------------------ playing */

  act(code: RoomCode, playerId: PlayerId, action: Action): Result<{ out: Outbound[] }> {
    const room = this.rooms.get(code);
    if (!room) return err("roomNotFound", "that room no longer exists");

    if (action.a === "snap") return this.submitSnap(room, playerId, action.targetId, action.slot);

    const result = reduce(room.state, playerId, action, this.ctx());
    if (!result.ok) return err(result.code, result.message);

    room.state = result.state;
    room.lastActivityAt = this.opts.now();
    this.armTurnClock(room);
    return { ok: true, out: result.out };
  }

  /**
   * Enter a snap into the race. Nothing is applied yet: the arbiter holds the
   * window open so a player on a worse connection still gets a fair shot.
   */
  private submitSnap(room: Room, playerId: PlayerId, targetId: PlayerId, slot: number): Result<{ out: Outbound[] }> {
    if (!seatOf(room.state, playerId)) return err("sessionInvalid", "you are not seated at this table");
    if (!snapOpen(room.state)) return err("illegalAction", "you cannot snap right now");

    room.arbiter.submit({
      playerId,
      targetId,
      slot,
      oneWayMs: room.rtt.oneWayFor(playerId),
    });
    room.lastActivityAt = this.opts.now();
    return { ok: true, out: [] };
  }

  /** Called when a snap window closes. Applies the winner and tells the losers. */
  private onSnapRace(code: RoomCode, race: SnapRace): void {
    const room = this.rooms.get(code);
    if (!room) return;

    const out: Outbound[] = [];

    if (race.winner !== null) {
      const result = reduce(
        room.state,
        race.winner.playerId,
        {
          a: "snapResolve",
          winnerId: race.winner.playerId,
          targetId: race.winner.targetId,
          slot: race.winner.slot,
          marginMs: race.marginMs,
        },
        this.ctx(),
      );
      if (result.ok) {
        room.state = result.state;
        out.push(...result.out);
        this.armTurnClock(room);
      }
    }

    // Everyone who lost the race is told so individually, so their optimistic
    // local flash can be rolled back.
    for (const loser of race.losers) {
      out.push({
        to: loser.playerId,
        event: {
          t: "snap.resolved",
          winnerId: race.winner?.playerId ?? null,
          targetId: loser.targetId,
          slot: loser.slot,
          outcome: "lostRace",
          marginMs: race.marginMs,
        },
      });
    }

    this.emitAsync(code, out);
  }

  recordPong(code: RoomCode, playerId: PlayerId, nonce: number): void {
    this.rooms.get(code)?.rtt.recordPong(playerId, nonce);
  }

  issuePing(code: RoomCode, playerId: PlayerId): number | null {
    const room = this.rooms.get(code);
    return room ? room.rtt.issuePing(playerId) : null;
  }

  /* -------------------------------------------------------- turn clock */

  /**
   * Keep a dropped or idle player from stalling the table. On expiry the server
   * plays the least damaging legal move rather than skipping the turn, so the
   * game state stays consistent.
   */
  private armTurnClock(room: Room): void {
    if (room.turnHandle !== null) {
      this.scheduler.clearTimeout(room.turnHandle);
      room.turnHandle = null;
    }
    const endsAt = room.state.turnEndsAt;
    if (endsAt === null || room.state.phase === "finished" || room.state.phase === "lobby") return;

    const delay = Math.max(0, endsAt - this.opts.now());
    room.turnHandle = this.scheduler.setTimeout(() => this.playTurnTimeout(room.code), delay);
  }

  private playTurnTimeout(code: RoomCode): void {
    const room = this.rooms.get(code);
    if (!room) return;
    room.turnHandle = null;

    const out: Outbound[] = [];
    const before = room.state.turnIndex;

    for (let step = 0; step < 4; step++) {
      const action = autoPlay(room.state);
      if (action === null) break;
      const result = reduce(room.state, room.state.seats[room.state.turnIndex]?.id ?? "", action, this.ctx());
      if (!result.ok) break;
      room.state = result.state;
      out.push(...result.out);
      if (room.state.turnIndex !== before || room.state.phase === "finished") break;
    }

    this.armTurnClock(room);
    this.emitAsync(code, out);
  }

  /* ------------------------------------------------------------- reaping */

  /** Drop rooms nobody has touched, so the registry cannot grow without bound. */
  reapIdleRooms(idleMs: number = ROOM_REAP_IDLE_MS): RoomCode[] {
    const cutoff = this.opts.now() - idleMs;
    const closed: RoomCode[] = [];
    for (const [code, room] of this.rooms) {
      const empty = room.state.seats.every((s) => !s.connected);
      if (empty && room.lastActivityAt <= cutoff) {
        this.closeRoom(code);
        closed.push(code);
      }
    }
    return closed;
  }

  closeRoom(code: RoomCode): void {
    const room = this.rooms.get(code);
    if (!room) return;

    room.arbiter.cancel();
    if (room.turnHandle !== null) this.scheduler.clearTimeout(room.turnHandle);
    for (const handle of room.graceHandles.values()) this.scheduler.clearTimeout(handle);

    for (const seat of room.state.seats) this.revokeSessionsFor(seat.id);
    this.rooms.delete(code);
  }
}

/** The least damaging legal move for the current phase. */
function autoPlay(state: GameState): Action | null {
  switch (state.phase) {
    case "study":
      return { a: "readyUp" };
    case "awaitingAction":
      return { a: "drawDeck" };
    case "holdingCard":
      // Discarding keeps the player's hand as it was; a swap would change it.
      return { a: "discardDrawn" };
    case "powerPeekOwn":
    case "powerPeekOther":
    case "powerFreeSwap":
    case "powerKing":
      return { a: "forfeitPower" };
    case "snapGiveCard":
      return { a: "snapGive", slot: 0 };
    default:
      return null;
  }
}

function cleanName(raw: string, fallback: string): string {
  const trimmed = raw.trim().slice(0, 16);
  return trimmed.length > 0 ? trimmed : fallback;
}
