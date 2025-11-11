# Cambio Server

WebSocket + Express server for real-time multiplayer card game.

## Architecture

The server uses a broadcast-only architecture with no rule enforcement in the MVP. It maintains in-memory game state and broadcasts all player actions to connected clients.

## Components

### Game Class (`game.ts`)

Manages the state for a single game instance:

```typescript
class Game {
  id: string;              // Unique game identifier
  deck: Card[];            // Remaining cards in deck
  discard: Card[];         // Discarded cards
  players: Map<...>;       // Connected players
  sendAll: (e: Event)=>void; // Broadcast function
}
```

**Methods:**

- `addPlayer(id, name)`: Register a new player
- `setDisconnected(id)`: Mark player as disconnected
- `draw(playerId)`: Draw a card from deck and discard it
- `slap(playerId)`: Broadcast a slap event
- `broadcastState()`: Send current table state to all players

### Deck Module (`deck.ts`)

Generates and shuffles a standard 52-card deck.

**Card Structure:**
```typescript
{
  id: string;          // e.g., "♠1", "♥13"
  value: number;       // 1-13 (Ace to King)
  points: number;      // min(value, 10) for scoring
  displayName: string; // e.g., "1♠", "13♥"
}
```

**Functions:**

- `genStandard52()`: Creates shuffled 52-card deck (4 suits × 13 values)
- `shuffle<T>(array)`: Fisher-Yates shuffle algorithm

### WebSocket Server (`index.ts`)

Express + ws server handling connections and message routing.

**Port:** 8080 (configurable via `PORT` env var)

**Endpoints:**
- `GET /health`: Health check returning `{ok: true}`

**WebSocket Connection Flow:**

1. Client connects via WebSocket
2. Client sends `join` message with `gameId` and `name`
3. Server assigns unique `playerId` (nanoid)
4. Server ensures game exists (creates if needed)
5. Player is added to game
6. Server sends `joined` confirmation
7. Game broadcasts state to all players
8. Subsequent messages route to game handlers

**Message Handlers:**

```typescript
// Join game (first message)
{ type: "join", gameId: string, name: string }
→ Creates/joins game, assigns playerId

// Draw card
{ type: "draw" }
→ game.draw(playerId)

// Slap event
{ type: "slap" }
→ game.slap(playerId)
```

**Connection Management:**

- Each WebSocket is mapped to `{ gameId, playerId }`
- On disconnect, player is marked as `connected: false`
- Game state is broadcast after player leaves

### Type Definitions (`types.ts`)

**Events (Server → Client):**

```typescript
type Event =
  | { type: "player.joined"; playerId: string; name: string }
  | { type: "player.left"; playerId: string }
  | { type: "action.draw"; playerId: string }
  | { type: "action.discard"; playerId: string; cardId: string }
  | { type: "action.slap"; playerId: string; ts: string }
  | { type: "state.table"; table: TableState }
  | { type: "meta.error"; message: string };
```

**Table State:**

```typescript
type TableState = {
  gameId: string;
  players: { id: string; name: string; connected: boolean }[];
  deckCount: number;
  discardTop?: string; // cardId of top discard
};
```

## Game State Flow

### Join Flow
```
Client: { type: "join", gameId: "demo", name: "Alice" }
  ↓
Server: Generate playerId "abc123"
  ↓
Server: ensureGame("demo") → create/fetch Game instance
  ↓
Server: game.addPlayer("abc123", "Alice")
  ↓
Broadcast: { type: "player.joined", playerId: "abc123", name: "Alice" }
Broadcast: { type: "state.table", table: {...} }
  ↓
Client: { type: "joined", playerId: "abc123", gameId: "demo" }
```

### Draw Flow
```
Client: { type: "draw" }
  ↓
Server: game.draw(playerId)
  ↓
Server: Pop card from deck
  ↓
Server: Push card to discard
  ↓
Broadcast: { type: "action.draw", playerId: "abc123" }
Broadcast: { type: "action.discard", playerId: "abc123", cardId: "♠7" }
Broadcast: { type: "state.table", table: {...} }
```

### Slap Flow
```
Client: { type: "slap" }
  ↓
Server: game.slap(playerId)
  ↓
Server: Generate timestamp with nanosecond precision
  ↓
Broadcast: { type: "action.slap", playerId: "abc123", ts: "2025-11-11T..." }
```

## Broadcast System

The broadcast function is passed to each Game instance during construction:

```typescript
const sendAll = (e: Event) => {
  for (const [ws, meta] of sockets) {
    if (meta.gameId === gameId && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(e));
    }
  }
};
```

This ensures:
- Events only go to players in the same game
- Only active WebSocket connections receive messages
- All events are JSON-serialized

## Data Structures

**games Map:**
```typescript
Map<string, Game>
// gameId → Game instance
```

**sockets Map:**
```typescript
Map<WebSocket, { gameId: string; playerId: string }>
// WebSocket → player metadata
```

## MVP Limitations

- No persistence (all state is in-memory)
- No authentication or authorization
- No rate limiting
- No rule validation (server trusts client actions)
- No hand management (cards immediately discarded)
- No turn order enforcement
- Games never expire or clean up

## Running

```bash
# Development (with hot reload)
npm run dev

# Build
npm run build

# Production
npm start
```

## Configuration

Environment variables:
- `PORT`: Server port (default: 8080)

## Dependencies

- `express`: HTTP server for health checks
- `cors`: CORS middleware
- `ws`: WebSocket library
- `nanoid`: Unique ID generation

## Future Enhancements

- Persistent storage (Redis, PostgreSQL)
- Authentication and session management
- Rate limiting and abuse prevention
- Game expiration and cleanup
- Rule enforcement on server side
- Hand management per player
- Turn-based validation
- Reconnection handling
- Admin commands (kick, ban, etc.)
