import { genStandard52, Card } from "./deck.js";
import type { TableState, Event } from "./types.js";

export class Game {
  id: string;
  deck: Card[] = [];
  discard: Card[] = [];
  players: Map<string, { id: string; name: string; connected: boolean }> = new Map();
  sendAll: (e: Event)=>void;

  constructor(id: string, sendAll: (e: Event)=>void) {
    this.id = id;
    this.deck = genStandard52();
    this.sendAll = sendAll;
    this.broadcastState();
  }

  addPlayer(id: string, name: string) {
    this.players.set(id, { id, name, connected: true });
    this.sendAll({ type: "player.joined", playerId: id, name });
    this.broadcastState();
  }

  setDisconnected(id: string) {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = false;
    this.sendAll({ type: "player.left", playerId: id });
    this.broadcastState();
  }

  draw(playerId: string) {
    if (!this.players.has(playerId)) return;
    const c = this.deck.pop();
    if (!c) return;
    // MVP: immediately discard drawn card to show loop (replace later with proper hand)
    this.discard.push(c);
    this.sendAll({ type: "action.draw", playerId });
    this.sendAll({ type: "action.discard", playerId, cardId: c.id });
    this.broadcastState();
  }

  slap(playerId: string) {
    const ts = `${new Date().toISOString()}.${process.hrtime.bigint()}`;
    this.sendAll({ type: "action.slap", playerId, ts });
    // MVP: no validation; just broadcast
  }

  broadcastState() {
    const state: TableState = {
      gameId: this.id,
      players: [...this.players.values()],
      deckCount: this.deck.length,
      discardTop: this.discard[this.discard.length-1]?.id
    };
    this.sendAll({ type: "state.table", table: state });
  }
}
