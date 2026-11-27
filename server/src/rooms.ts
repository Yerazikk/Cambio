import {
  DEFAULT_RULES,
  isCardBack,
  MAX_DECKS,
  MAX_PLAYERS,
  MIN_DECKS,
  initialPeekSlots,
  MIN_PLAYERS,
  RECONNECT_GRACE_LOBBY_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_REAP_IDLE_MS,
  type Action,
  type EngineAction,
  type ErrorCode,
  type PlayerId,
  type RoomCode,
  type RuleConfig,
} from "@cambio/shared";
import { reduce, slapLanded, type Outbound, type ReduceCtx } from "./engine/reduce.js";
import { addSeat, emptyState, returnToLobby, startRound } from "./engine/setup.js";
import {
  isLocked,
  lockHolder,
  seatOf,
  slapOpen,
  viewFor,
  type GameState,
  type SlapQueueEntry,
} from "./engine/state.js";
import type { Rng } from "./rng.js";
import { RttTracker } from "./rtt.js";
import { SlapArbiter, realScheduler, type Scheduler, type SlapRace } from "./slap.js";

export type Session = { token: string; playerId: PlayerId; code: RoomCode };

export type Room = {
  code: RoomCode;
  state: GameState;
  arbiter: SlapArbiter;
  rtt: RttTracker;
  /** Seats whose player has dropped but whose grace period is still running. */
  graceHandles: Map<PlayerId, unknown>;
  turnHandle: unknown;
  /** Runs while a slapper holds the table and has not yet named a card. */
  lockHandle: unknown;
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
  /**
   * Override how long a dropped player's lobby seat is held. Tests shorten it.
   * There is no in-game equivalent: a seat in a round is held to the end of it.
   */
  graceMs?: { lobby?: number };
  /**
   * Output produced by a timer rather than by a client message: a settled slap
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
      arbiter: new SlapArbiter({
        windowMs: this.rules.slapWindowMs,
        now: this.opts.now,
        scheduler: this.scheduler,
        onResolve: (race) => this.onSlapRace(code, race),
      }),
      graceHandles: new Map(),
      turnHandle: null,
      lockHandle: null,
      lastActivityAt: this.opts.now(),
    };
    this.rooms.set(code, room);
    this.sessions.set(token, { token, playerId, code });

    return { ok: true, code, playerId, token };
  }

  /**
   * Sit down at a table, or get back into one.
   *
   * The code and the name together are enough to reclaim a seat: a player who
   * dropped mid-round, cleared their storage, or came back on a different
   * device has no token left, and the alternative to letting the name back in
   * is telling them their game is gone. A seat somebody is still sitting in is
   * never handed over, so this cannot be used to steal one.
   */
  joinRoom(code: RoomCode, name: string): Result<{ code: RoomCode; playerId: PlayerId; token: string }> {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) return err("roomNotFound", `no room with the code ${code}`);

    const wanted = cleanName(name, "player");
    const sameName = room.state.seats.find((s) => s.name.toLowerCase() === wanted.toLowerCase());

    if (sameName !== undefined) {
      if (sameName.connected) return err("nameTaken", `someone at that table is already called ${wanted}`);
      return this.reclaim(room, sameName.id);
    }

    if (room.state.phase !== "lobby") return err("gameAlreadyStarted", "that game is already under way");
    if (room.state.seats.length >= MAX_PLAYERS) return err("roomFull", `that table is full (${MAX_PLAYERS} players)`);

    const playerId = this.nextId();
    const token = this.nextId();
    room.state = addSeat(room.state, { id: playerId, name: wanted });
    room.lastActivityAt = this.opts.now();
    this.sessions.set(token, { token, playerId, code: room.code });

    return { ok: true, code: room.code, playerId, token };
  }

  /**
   * Hand an empty seat back to the player it belongs to, with a fresh token.
   *
   * Every token the seat had before is dropped: they are no use to whoever
   * held them, and leaving them live would let a stale tab answer for a player
   * who has already come back somewhere else.
   */
  private reclaim(room: Room, playerId: PlayerId): Ok<{ code: RoomCode; playerId: PlayerId; token: string }> {
    this.cancelGrace(room, playerId);
    this.revokeSessionsFor(playerId);

    const seat = seatOf(room.state, playerId);
    if (seat) seat.connected = true;
    room.state.version += 1;
    room.lastActivityAt = this.opts.now();

    const token = this.nextId();
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
   * Mark a player as dropped. The seat is held so a dropped connection does
   * not cost them the game.
   *
   * In a round it is held with no timer at all: turn order steps over an empty
   * seat, slapping is not open to one, and the player walks back into it
   * whenever they manage to get back - by token if they still have one, by
   * name if they do not. Losing a round to a flaky connection is the worst
   * thing this game can do to someone, so it does not do it, and the host can
   * still remove anyone who is plainly not coming back.
   *
   * In the lobby a seat is cheap to retake, so a dropped one is cleared after
   * a couple of minutes rather than left as furniture.
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
    this.cancelGrace(room, playerId);

    /*
     * The one thing a dropped player must not do is leave the table stopped.
     * With no clock on naming a card, a slapper who vanishes mid-slap would
     * hold the game up for the rest of the round, so their place in the queue
     * goes with them.
     */
    this.dropFromSlapQueue(room, playerId);

    if (room.state.phase !== "lobby") return;

    const graceMs = this.opts.graceMs?.lobby ?? RECONNECT_GRACE_LOBBY_MS;
    room.graceHandles.set(
      playerId,
      this.scheduler.setTimeout(() => this.vacateSeat(code, playerId), graceMs),
    );
  }

  /**
   * Take a player out of the slap queue, and let the table go if they were
   * the one it was waiting on.
   */
  private dropFromSlapQueue(room: Room, playerId: PlayerId): void {
    const lock = room.state.slapLock;
    if (lock === null) return;
    const before = lock.queue.length;
    lock.queue = lock.queue.filter((entry) => entry.playerId !== playerId);
    if (lock.queue.length === before) return;

    room.state.version += 1;
    const out: Outbound[] = [];
    this.pumpLock(room, out);
    this.emitAsync(room.code, out);
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

/**
   * Leave voluntarily.
   *
   * From the lobby the seat goes at once - there is nothing to come back to.
   * Mid-round it is held exactly like a dropped connection, because the two
   * are indistinguishable from the inside: closing the tab, losing signal and
   * hitting Leave by mistake all look the same an hour later, and only one of
   * them should cost somebody their round. The seat can be walked back into
   * with the same name, and the host can clear it.
   */
  leave(code: RoomCode, playerId: PlayerId): void {
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.state.phase !== "lobby") {
      this.disconnect(code, playerId);
      return;
    }
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
   * Choose whether a power may be declined. Lobby only, like the deck count:
   * it changes how a turn plays, and a rule cannot change under a round that
   * is already being played.
   */
  setPowers(code: RoomCode, byPlayerId: PlayerId, optional: boolean): Result<{ optionalPowers: boolean }> {
    const room = this.rooms.get(code);
    if (!room) return err("roomNotFound", "that room no longer exists");
    if (room.state.hostId !== byPlayerId) return err("notHost", "only the host can change the rules");
    if (room.state.phase !== "lobby") return err("illegalAction", "the rules are set before the round starts");
    if (typeof optional !== "boolean") return err("malformed", "powers are either optional or not");

    room.state.rules = { ...room.state.rules, optionalPowers: optional };
    room.state.version += 1;
    room.lastActivityAt = this.opts.now();
    return { ok: true, optionalPowers: optional };
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
   * Play again: take the whole table back to its lobby.
   *
   * Not straight into a fresh deal. Between rounds is when a table changes its
   * mind - another pack, a different back, somebody joining or going - and
   * dealing immediately gave nobody the chance. The lobby is also where a
   * player who dropped in the last round is picked up again.
   *
   * Any player may do it rather than the host alone. The round is over, so
   * there is nothing left to disrupt, and a table whose host has wandered off
   * should not be stuck staring at a scoreboard.
   */
  restart(code: RoomCode, byPlayerId: PlayerId): Result<{ out: Outbound[] }> {
    const room = this.rooms.get(code);
    if (!room) return err("roomNotFound", "that room no longer exists");
    if (!seatOf(room.state, byPlayerId)) return err("sessionInvalid", "you are not seated at this table");
    if (room.state.phase !== "finished") return err("illegalAction", "finish this round first");

    room.arbiter.cancel();
    this.clearLockClock(room);
    this.margins.delete(room.code);
    room.state = returnToLobby(room.state);
    // A seat held open through the round is only held for that round. Back in
    // the lobby it is an ordinary empty chair, on the ordinary lobby clock.
    for (const seat of room.state.seats) {
      if (!seat.connected) this.disconnect(code, seat.id);
    }
    room.lastActivityAt = this.opts.now();
    return { ok: true, out: [] };
  }

  /* ------------------------------------------------------------ playing */

  act(code: RoomCode, playerId: PlayerId, action: Action): Result<{ out: Outbound[] }> {
    const room = this.rooms.get(code);
    if (!room) return err("roomNotFound", "that room no longer exists");

    if (action.a === "slapClaim") return this.claimSlap(room, playerId, null, null);
    if (action.a === "slap") {
      // While you hold the lock the table is already stopped on you, so naming
      // a card answers it rather than starting a second slap.
      if (lockHolder(room.state)?.playerId === playerId) {
        return this.answerSlap(room, playerId, action.targetId, action.slot);
      }
      return this.claimSlap(room, playerId, action.targetId, action.slot);
    }

    const result = reduce(room.state, playerId, action, this.ctx());
    if (!result.ok) return err(result.code, result.message);

    room.state = result.state;
    room.lastActivityAt = this.opts.now();
    this.armTurnClock(room);
    return { ok: true, out: result.out };
  }

  /**
   * Enter a slap into the queue.
   *
   * Nothing is applied yet. If the table is still running, the arbiter holds a
   * short window open so a player on a worse connection still gets a fair shot
   * at being first; if it is already stopped on somebody else's slap, this one
   * joins the back of their queue instead.
   */
  private claimSlap(
    room: Room,
    playerId: PlayerId,
    targetId: PlayerId | null,
    slot: number | null,
  ): Result<{ out: Outbound[] }> {
    if (!seatOf(room.state, playerId)) return err("sessionInvalid", "you are not seated at this table");
    if (!slapOpen(room.state)) return err("illegalAction", "you cannot slap right now");

    room.lastActivityAt = this.opts.now();

    const lock = room.state.slapLock;
    if (lock !== null) {
      const held = lock.queue.find((entry) => entry.playerId === playerId);
      if (held !== undefined) {
        // One place in the queue per player. A second press is the same finger,
        // not a second bet - but it may be the card arriving for a bare claim.
        if (held.targetId === null && targetId !== null) {
          held.targetId = targetId;
          held.slot = slot;
          room.state.version += 1;
        }
        return { ok: true, out: [] };
      }
      lock.queue.push({ playerId, targetId, slot });
      room.state.version += 1;
      return { ok: true, out: [] };
    }

    room.arbiter.submit({ playerId, targetId, slot, oneWayMs: room.rtt.oneWayFor(playerId) });
    return { ok: true, out: [] };
  }

  /** The holder of the lock names the card their slap meant. */
  private answerSlap(room: Room, playerId: PlayerId, targetId: PlayerId, slot: number): Result<{ out: Outbound[] }> {
    const holder = lockHolder(room.state);
    if (holder === null || holder.playerId !== playerId) {
      return err("illegalAction", "the table is not waiting on your slap");
    }

    holder.targetId = targetId;
    holder.slot = slot;
    room.state.version += 1;
    room.lastActivityAt = this.opts.now();

    const out: Outbound[] = [];
    this.pumpLock(room, out);
    return { ok: true, out };
  }

  /**
   * Called when a slap window closes. The race becomes the queue, and the
   * table stops until that queue has emptied.
   *
   * Slapping at the same moment as someone else does not cancel your slap, it
   * puts you behind them: each slap in turn is played in full, and the queue
   * stops at the first one that is right. If the player ahead of you was
   * wrong, yours is still played - and you still owe the table a card.
   */
  private onSlapRace(code: RoomCode, race: SlapRace): void {
    const room = this.rooms.get(code);
    if (!room) return;

    const queue: SlapQueueEntry[] = [...race.order, ...race.late].map((claim) => ({
      playerId: claim.playerId,
      targetId: claim.targetId,
      slot: claim.slot,
    }));
    if (queue.length === 0) return;

    this.engageLock(room, queue, race);

    const out: Outbound[] = [];
    this.pumpLock(room, out);
    this.emitAsync(code, out);
  }

  /**
   * Stop the table on a slap.
   *
   * What is left of the interrupted turn's clock is put aside rather than left
   * to run down: a player must not lose their turn because somebody else
   * slapped during it.
   */
  private engageLock(room: Room, queue: SlapQueueEntry[], race: SlapRace | null): void {
    const now = this.opts.now();
    const remaining = room.state.turnEndsAt === null ? null : Math.max(0, room.state.turnEndsAt - now);

    room.state.slapLock = { queue, endsAt: null, turnRemainingMs: remaining };
    room.state.turnEndsAt = null;
    room.state.version += 1;
    this.armTurnClock(room);
    this.margins.set(room.code, race);
  }

  /** How far apart the slaps in each room's open queue landed, for the report. */
  private readonly margins = new Map<RoomCode, SlapRace | null>();

  private marginFor(code: RoomCode, playerId: PlayerId, first: boolean): number | null {
    const race = this.margins.get(code) ?? null;
    if (race === null) return null;
    if (first) return race.marginMs;
    return [...race.order, ...race.late].find((c) => c.playerId === playerId)?.behindMs ?? null;
  }

  /**
   * Play the queue as far as it will go.
   *
   * It runs while the head of the queue has named a card and stops the moment
   * one has not - that stop is the pause the slapper is given to pick. A slap
   * that lands ends the queue outright: everyone behind it keeps their cards,
   * which is why being second only costs you anything when the player ahead of
   * you was wrong.
   */
  private pumpLock(room: Room, out: Outbound[]): void {
    let played = 0;

    for (;;) {
      const lock = room.state.slapLock;
      if (lock === null) return;

      const head = lock.queue[0];
      if (head === undefined) {
        this.releaseLock(room, out, null);
        return;
      }

      // A seat that has since been given up cannot answer for its slap.
      if (!seatOf(room.state, head.playerId)) {
        lock.queue.shift();
        room.state.version += 1;
        continue;
      }

      if (head.targetId === null || head.slot === null) {
        // The table is now waiting on this player, with a clock on it.
        this.armLockClock(room);
        return;
      }

      played += 1;
      const result = reduce(
        room.state,
        head.playerId,
        {
          a: "slapResolve",
          slapperId: head.playerId,
          targetId: head.targetId,
          slot: head.slot,
          // The first slap is reported by how far clear it was; every one
          // after it by how far behind the first it landed.
          marginMs: this.marginFor(room.code, head.playerId, played === 1),
        },
        this.ctx(),
      );
      if (!result.ok) {
        lock.queue.shift();
        room.state.version += 1;
        continue;
      }

      room.state = result.state;
      out.push(...result.out);

      if (landed(result.out)) {
        this.releaseLock(room, out, head.playerId);
        return;
      }

      room.state.slapLock?.queue.shift();
      room.state.version += 1;
    }
  }

  /**
   * Let the table go again.
   *
   * Everyone still queued is told, privately, that their slap was never played:
   * the one ahead of them was right, so it cost them nothing. The rest of the
   * table has no business knowing they tried.
   */
  private releaseLock(room: Room, out: Outbound[], endedById: PlayerId | null): void {
    const lock = room.state.slapLock;
    if (lock === null) return;

    for (const spared of lock.queue.slice(1)) {
      out.push({
        to: spared.playerId,
        event: {
          t: "slap.resolved",
          slapperId: spared.playerId,
          targetId: spared.targetId ?? spared.playerId,
          slot: spared.slot ?? 0,
          outcome: "lostRace",
          // Nothing was turned over, so there is no card to show.
          card: null,
          endedById,
          marginMs: this.marginFor(room.code, spared.playerId, false),
        },
      });
    }

    this.clearLockClock(room);
    room.state.slapLock = null;
    this.margins.delete(room.code);

    // Give the interrupted turn back the clock it was holding when the slap
    // stopped the table.
    const alive = room.state.phase !== "finished" && room.state.phase !== "lobby";
    if (alive && lock.turnRemainingMs !== null && room.state.turnEndsAt === null) {
      room.state.turnEndsAt = this.opts.now() + lock.turnRemainingMs;
    }
    room.state.version += 1;
    this.armTurnClock(room);
  }

  private clearLockClock(room: Room): void {
    if (room.lockHandle !== null) {
      this.scheduler.clearTimeout(room.lockHandle);
      room.lockHandle = null;
    }
  }

/**
   * The holder's time to name a card, where a table has any.
   *
   * This one does not: `slapPickMs` is 0, so the table simply waits. What
   * keeps it from waiting for ever is the holder dropping, which gives up
   * their place in the queue - see `disconnect`.
   */
  private armLockClock(room: Room): void {
    this.clearLockClock(room);
    const lock = room.state.slapLock;
    if (lock === null) return;

    const pickMs = room.state.rules.slapPickMs;
    if (pickMs <= 0) return;

    lock.endsAt = this.opts.now() + pickMs;
    room.state.version += 1;
    room.lockHandle = this.scheduler.setTimeout(() => this.playLockTimeout(room.code), pickMs);
  }

  private playLockTimeout(code: RoomCode): void {
    const room = this.rooms.get(code);
    if (!room) return;
    room.lockHandle = null;

    const head = lockHolder(room.state);
    if (head === null) return;

    const out: Outbound[] = [];
    const result = reduce(room.state, head.playerId, { a: "slapForfeit", slapperId: head.playerId }, this.ctx());
    if (result.ok) {
      room.state = result.state;
      out.push(...result.out);
    }
    room.state.slapLock?.queue.shift();
    room.state.version += 1;

    this.pumpLock(room, out);
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
    // A stopped table has no turn clock; it is handed back when the slap queue
    // empties, with exactly what was left on it.
    if (isLocked(room.state)) return;

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
    if (room.lockHandle !== null) this.scheduler.clearTimeout(room.lockHandle);
    for (const handle of room.graceHandles.values()) this.scheduler.clearTimeout(handle);

    for (const seat of room.state.seats) this.revokeSessionsFor(seat.id);
    this.rooms.delete(code);
  }
}

/** The least damaging legal move for the current phase. */
function autoPlay(state: GameState): EngineAction | null {
  switch (state.phase) {
    case "study": {
      // Ready now needs the two cards actually looked at, so the clock has to
      // look at them on the player's behalf before it can call them ready.
      const seat = state.seats.find((s) => !s.ready);
      if (seat === undefined) return { a: "readyUp" };
      const unstudied = initialPeekSlots(seat.hand.length, state.rules.initialPeeks).find(
        (slot) => !seat.initialPeeked.includes(slot),
      );
      return unstudied === undefined ? { a: "readyUp" } : { a: "initialPeek", slot: unstudied };
    }
    case "awaitingAction":
      return { a: "drawDeck" };
    case "holdingCard":
      // Discarding keeps the player's hand as it was; a swap would change it.
      return { a: "discardDrawn" };
    case "powerPeekOwn":
    case "powerPeekOther":
    case "powerFreeSwap":
    case "powerKing":
      // Not `forfeitPower`: at a table where powers are compulsory no player
      // may decline one, and the clock is not a player.
      return { a: "powerTimeout" };
    case "powerKingChoice":
      // The king has already had its look. Leaving both cards where they are
      // is the move that changes nobody's hand.
      return { a: "kingSkip" };
    case "slapGiveCard":
      return { a: "slapGive", slot: firstHeldSlot(state) };
    default:
      return null;
  }
}

/** The first slot the card-payer still has a card in. Holes are not payable. */
function firstHeldSlot(state: GameState): number {
  const seat = state.slapGiveFor === null ? undefined : seatOf(state, state.slapGiveFor.slapperId);
  if (seat === undefined) return 0;
  const index = seat.hand.findIndex((id) => id !== null);
  return index === -1 ? 0 : index;
}

function cleanName(raw: string, fallback: string): string {
  const trimmed = raw.trim().slice(0, 16);
  return trimmed.length > 0 ? trimmed : fallback;
}

/** Did the slap just reduced actually land, and so end the queue behind it? */
function landed(out: readonly Outbound[]): boolean {
  return out.some((o) => o.event.t === "slap.resolved" && slapLanded(o.event.outcome));
}
