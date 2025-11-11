# Cambio Client

Vite + TypeScript client for real-time multiplayer card game.

## Overview

Simple browser-based client that connects to the Cambio WebSocket server and provides a minimal UI for testing multiplayer functionality.

## Structure

```
client/
├── index.html         # UI with input fields and action buttons
├── src/
│   └── main.ts        # WebSocket client logic
├── vite.config.ts     # Vite dev server configuration
├── tsconfig.json      # TypeScript configuration
└── package.json       # Dependencies and scripts
```

## Features

- WebSocket connection to game server
- Real-time event logging
- Join game with custom name and game ID
- Draw cards from deck
- Send slap events
- Live updates for all player actions

## Running

```bash
# Development server (port 5173)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## User Interface

The MVP provides a minimal text-based interface:

### Inputs
- **Name**: Your player name (default: "Guest")
- **Game ID**: Room to join (default: "demo")

### Buttons
- **Join**: Connect to WebSocket server and join game
- **Draw**: Draw a card from the deck
- **Slap**: Send a slap event with timestamp

### Log Area
Pre-formatted text area displaying all incoming events in JSON format.

## WebSocket Events

### Outgoing (Client → Server)

**Join Game:**
```typescript
ws.send(JSON.stringify({
  type: "join",
  gameId: "demo",
  name: "Alice"
}));
```

**Draw Card:**
```typescript
ws.send(JSON.stringify({ type: "draw" }));
```

**Slap:**
```typescript
ws.send(JSON.stringify({ type: "slap" }));
```

### Incoming (Server → Client)

**Joined Confirmation:**
```json
{
  "type": "joined",
  "playerId": "abc123",
  "gameId": "demo"
}
```

**Player Joined:**
```json
{
  "type": "player.joined",
  "playerId": "abc123",
  "name": "Alice"
}
```

**Player Left:**
```json
{
  "type": "player.left",
  "playerId": "abc123"
}
```

**Action - Draw:**
```json
{
  "type": "action.draw",
  "playerId": "abc123"
}
```

**Action - Discard:**
```json
{
  "type": "action.discard",
  "playerId": "abc123",
  "cardId": "♠7"
}
```

**Action - Slap:**
```json
{
  "type": "action.slap",
  "playerId": "abc123",
  "ts": "2025-11-11T12:34:56.789Z.123456789"
}
```

**Table State:**
```json
{
  "type": "state.table",
  "table": {
    "gameId": "demo",
    "players": [
      { "id": "abc123", "name": "Alice", "connected": true }
    ],
    "deckCount": 51,
    "discardTop": "♠7"
  }
}
```

**Error:**
```json
{
  "type": "meta.error",
  "message": "Error description"
}
```

## Code Walkthrough

### main.ts

**WebSocket Connection:**
```typescript
const ws = new WebSocket(
  (location.protocol === "https:" ? "wss" : "ws") +
  "://" +
  location.host.replace(":5173", ":8080")
);
```

This automatically:
- Uses `wss://` for HTTPS pages, `ws://` for HTTP
- Replaces Vite's port (5173) with server port (8080)

**Event Handlers:**
```typescript
ws.onopen = () => {
  // Send join message when connection opens
  ws.send(JSON.stringify({ type: "join", gameId, name }));
};

ws.onmessage = (ev) => {
  // Log all incoming messages
  log(JSON.parse(ev.data));
};

ws.onclose = () => {
  // Connection closed
  log("closed");
};
```

**Log Function:**
```typescript
const log = (x: any) => {
  const el = document.getElementById("log")!;
  el.textContent = `${el.textContent}\n${
    typeof x === 'string' ? x : JSON.stringify(x)
  }`;
};
```

Appends messages to the log area, automatically formatting objects as JSON.

## Testing Multiplayer

### Single Machine Testing

1. Open http://localhost:5173 in multiple browser tabs/windows
2. Use different names in each tab
3. Use the same game ID (e.g., "demo")
4. Click "Join" in each tab
5. Perform actions and watch events propagate

### Network Testing

1. Get your local IP address (e.g., `192.168.1.100`)
2. Update WebSocket URL in `main.ts` or use environment variable
3. Connect from different devices on the same network
4. All devices should see synchronized events

## Configuration

### Vite Dev Server

```typescript
// vite.config.ts
export default {
  server: {
    port: 5173
  }
};
```

Change port if 5173 is already in use.

### WebSocket Server URL

Currently hardcoded in `main.ts`:
```typescript
location.host.replace(":5173", ":8080")
```

For production, use environment variables:
```typescript
const WS_URL = import.meta.env.VITE_WS_URL ||
  (location.protocol === "https:" ? "wss" : "ws") +
  "://" + location.host.replace(":5173", ":8080");
```

## MVP Limitations

- No visual card rendering (just JSON logs)
- No error handling UI
- No reconnection logic
- No offline detection
- No loading states
- No form validation
- No responsive design
- Single WebSocket connection (no reconnect)

## Browser Compatibility

Requires modern browsers with:
- WebSocket support
- ES2022 JavaScript
- TypeScript target features

Tested on:
- Chrome 100+
- Firefox 100+
- Safari 15+
- Edge 100+

## Future Enhancements

### UI Improvements
- Visual card components with suits and values
- Player list with avatars
- Game state visualization (deck count, discard pile)
- Chat system
- Sound effects and animations
- Mobile-responsive layout

### Features
- Reconnection with state recovery
- Offline mode detection
- Network status indicator
- Turn indicator
- Timer displays
- Score tracking
- Game history

### Developer Experience
- TypeScript types shared with server
- Environment-based configuration
- Error boundaries
- Debug mode with verbose logging
- Performance monitoring

## Dependencies

### Runtime
None (Vanilla TypeScript + browser APIs)

### Development
- `vite`: Fast build tool and dev server
- `typescript`: Type checking and compilation

## Building for Production

```bash
npm run build
```

Outputs to `dist/` directory:
- Optimized JavaScript bundle
- Minified assets
- Source maps

Deploy `dist/` to any static hosting:
- Netlify
- Vercel
- GitHub Pages
- AWS S3
- Nginx/Apache

### Environment Variables

Create `.env` file for production:

```bash
VITE_WS_URL=wss://your-server.com
```

Access in code:
```typescript
const wsUrl = import.meta.env.VITE_WS_URL;
```

## Debugging

### Enable Verbose Logging

```typescript
// In main.ts
ws.onmessage = (ev) => {
  const data = JSON.parse(ev.data);
  console.log('[WS Received]', data);
  log(data);
};
```

### Browser DevTools

1. Open DevTools (F12)
2. Go to Network tab
3. Filter by "WS" (WebSocket)
4. Click on connection to see frames
5. Inspect sent/received messages

### Common Issues

**Connection refused:**
- Ensure server is running on port 8080
- Check firewall settings
- Verify WebSocket URL

**Messages not appearing:**
- Check browser console for errors
- Verify JSON format of messages
- Ensure game IDs match across clients

**Disconnections:**
- Check network stability
- Look for server errors
- Verify WebSocket protocol (ws:// vs wss://)
