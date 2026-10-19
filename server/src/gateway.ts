import type { ClientMsg, ErrorCode, PlayerId, RoomCode, ServerEvent } from "@cambio/shared";
import type { Outbound } from "./engine/reduce.js";
import type { RoomManager } from "./rooms.js";

export type Binding = { code: RoomCode; playerId: PlayerId };

export type GatewayOptions<S> = {
  manager: RoomManager;
  send: (socket: S, event: ServerEvent) => void;
};

export type Gateway<S> = {
  handle: (socket: S, msg: ClientMsg) => void;
  drop: (socket: S) => void;
  deliver: (code: RoomCode, out: Outbound[]) => void;
  broadcastState: (code: RoomCode) => void;
  sendTo: (socket: S, event: ServerEvent) => void;
  pingAll: () => void;
  bindingOf: (socket: S) => Binding | undefined;
  socketCount: () => number;
};

/**
 * Translates between sockets and the room manager.
 *
 * Generic over the socket type so the integration tests can drive it with real
 * `ws` connections while nothing here depends on `ws` itself. The important
 * invariant is that no client is ever handed raw game state: every send of
 * table state goes through `stateView`, which redacts per player.
 */
export function createGateway<S>(opts: GatewayOptions<S>): Gateway<S> {
  const { manager, send } = opts;

  const bySocket = new Map<S, Binding>();
  const byPlayer = new Map<string, S>();

  const key = (code: RoomCode, playerId: PlayerId) => `${code}:${playerId}`;

  function bind(socket: S, binding: Binding): void {
    bySocket.set(socket, binding);
    byPlayer.set(key(binding.code, binding.playerId), socket);
  }

  function unbind(socket: S): Binding | undefined {
    const binding = bySocket.get(socket);
    if (!binding) return undefined;
    bySocket.delete(socket);
    const k = key(binding.code, binding.playerId);
    // Only clear the reverse entry if it still points at this socket; a resumed
    // player may already have claimed it with a new one.
    if (byPlayer.get(k) === socket) byPlayer.delete(k);
    return binding;
  }

  function socketFor(code: RoomCode, playerId: PlayerId): S | undefined {
    return byPlayer.get(key(code, playerId));
  }

  function sendTo(socket: S, event: ServerEvent): void {
    send(socket, event);
  }

  function fail(socket: S, code: ErrorCode, message: string): void {
    send(socket, { t: "error", code, message });
  }

  /** Personalized state to every seated player. The only way table state ships. */
  function broadcastState(code: RoomCode): void {
    for (const playerId of manager.membersOf(code)) {
      const socket = socketFor(code, playerId);
      if (!socket) continue;
      const view = manager.stateView(code, playerId);
      if (view) send(socket, { t: "game.state", view });
    }
  }

  function deliver(code: RoomCode, out: Outbound[]): void {
    for (const item of out) {
      if (item.to === "all") {
        for (const playerId of manager.membersOf(code)) {
          const socket = socketFor(code, playerId);
          if (socket) send(socket, item.event);
        }
      } else {
        const socket = socketFor(code, item.to);
        if (socket) send(socket, item.event);
      }
    }
    broadcastState(code);
  }

  function handle(socket: S, msg: ClientMsg): void {
    switch (msg.t) {
      case "room.create": {
        if (bySocket.has(socket)) {
          fail(socket, "illegalAction", "this connection is already at a table");
          return;
        }
        const result = manager.createRoom(msg.name);
        bind(socket, { code: result.code, playerId: result.playerId });
        send(socket, { t: "hello", playerId: result.playerId, token: result.token, code: result.code });
        broadcastState(result.code);
        return;
      }

      case "room.join": {
        if (bySocket.has(socket)) {
          // The old server minted a second player id here and orphaned the
          // first; a connection now holds exactly one seat.
          fail(socket, "illegalAction", "this connection is already at a table");
          return;
        }
        const result = manager.joinRoom(msg.code, msg.name);
        if (!result.ok) {
          fail(socket, result.code, result.message);
          return;
        }
        bind(socket, { code: result.code, playerId: result.playerId });
        send(socket, { t: "hello", playerId: result.playerId, token: result.token, code: result.code });
        broadcastState(result.code);
        return;
      }

      case "room.resume": {
        const result = manager.resume(msg.token);
        if (!result.ok) {
          fail(socket, result.code, result.message);
          return;
        }
        // Drop any stale socket still holding this seat, so a fast refresh does
        // not leave a zombie connection receiving the player's cards.
        const previous = socketFor(result.code, result.playerId);
        if (previous !== undefined && previous !== socket) bySocket.delete(previous);

        bind(socket, { code: result.code, playerId: result.playerId });
        send(socket, { t: "hello", playerId: result.playerId, token: msg.token, code: result.code });
        broadcastState(result.code);
        return;
      }

      case "room.leave": {
        const binding = unbind(socket);
        if (!binding) return;
        manager.leave(binding.code, binding.playerId);
        broadcastState(binding.code);
        return;
      }

      case "lobby.kick": {
        const binding = bySocket.get(socket);
        if (!binding) {
          fail(socket, "sessionInvalid", "join a table first");
          return;
        }
        const result = manager.kick(binding.code, binding.playerId, msg.playerId);
        if (!result.ok) {
          fail(socket, result.code, result.message);
          return;
        }
        const target = socketFor(binding.code, msg.playerId);
        if (target) {
          send(target, { t: "kicked", reason: "the host removed you from the table" });
          unbind(target);
        }
        broadcastState(binding.code);
        return;
      }

      case "lobby.decks": {
        const binding = bySocket.get(socket);
        if (!binding) {
          fail(socket, "sessionInvalid", "join a table first");
          return;
        }
        const result = manager.setDecks(binding.code, binding.playerId, msg.decks);
        if (!result.ok) {
          fail(socket, result.code, result.message);
          return;
        }
        broadcastState(binding.code);
        return;
      }

      case "lobby.back": {
        const binding = bySocket.get(socket);
        if (!binding) {
          fail(socket, "sessionInvalid", "join a table first");
          return;
        }
        const result = manager.setBack(binding.code, binding.playerId, msg.back);
        if (!result.ok) {
          fail(socket, result.code, result.message);
          return;
        }
        broadcastState(binding.code);
        return;
      }

      case "lobby.start": {
        const binding = bySocket.get(socket);
        if (!binding) {
          fail(socket, "sessionInvalid", "join a table first");
          return;
        }
        const result = manager.start(binding.code, binding.playerId);
        if (!result.ok) {
          fail(socket, result.code, result.message);
          return;
        }
        deliver(binding.code, result.out);
        return;
      }

      case "lobby.restart": {
        const binding = bySocket.get(socket);
        if (!binding) {
          fail(socket, "sessionInvalid", "join a table first");
          return;
        }
        const result = manager.restart(binding.code, binding.playerId);
        if (!result.ok) {
          fail(socket, result.code, result.message);
          return;
        }
        deliver(binding.code, result.out);
        return;
      }

      case "act": {
        const binding = bySocket.get(socket);
        if (!binding) {
          fail(socket, "sessionInvalid", "join a table first");
          return;
        }
        const result = manager.act(binding.code, binding.playerId, msg.action);
        if (!result.ok) {
          fail(socket, result.code, result.message);
          return;
        }
        deliver(binding.code, result.out);
        return;
      }

      case "pong": {
        const binding = bySocket.get(socket);
        if (binding) manager.recordPong(binding.code, binding.playerId, msg.nonce);
        return;
      }

      default: {
        const never: never = msg;
        fail(socket, "malformed", `unknown message: ${JSON.stringify(never)}`);
      }
    }
  }

  function drop(socket: S): void {
    const binding = unbind(socket);
    if (!binding) return;
    // The seat is held, not freed: a refresh must not cost the player their game.
    manager.disconnect(binding.code, binding.playerId);
    broadcastState(binding.code);
  }

  function pingAll(): void {
    for (const [socket, binding] of bySocket) {
      const nonce = manager.issuePing(binding.code, binding.playerId);
      if (nonce !== null) send(socket, { t: "ping", nonce });
    }
  }

  return {
    handle,
    drop,
    deliver,
    broadcastState,
    sendTo,
    pingAll,
    bindingOf: (socket) => bySocket.get(socket),
    socketCount: () => bySocket.size,
  };
}
