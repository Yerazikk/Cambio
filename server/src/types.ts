export type Event =
  | { type: "player.joined"; playerId: string; name: string }
  | { type: "player.left"; playerId: string }
  | { type: "action.draw"; playerId: string }
  | { type: "action.discard"; playerId: string; cardId: string }
  | { type: "action.slap"; playerId: string; ts: string } // ISO + nano suffix
  | { type: "state.table"; table: TableState }
  | { type: "meta.error"; message: string };

export type TableState = {
  gameId: string;
  players: { id: string; name: string; connected: boolean }[];
  deckCount: number;
  discardTop?: string; // cardId
};
