import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { nanoid } from "nanoid";
import { Game } from "./game.js";
import type { Event } from "./types.js";

const app = express();
app.use(cors());
app.get("/health", (_,res)=>res.json({ok:true}));

const server = app.listen(process.env.PORT || 8080, ()=>{
  console.log("HTTP on", (server.address() as any).port);
});

const wss = new WebSocketServer({ server });
const games = new Map<string, Game>();
const sockets = new Map<WebSocket, { gameId: string; playerId: string }>();

function ensureGame(id: string) {
  if (!games.has(id)) {
    const g = new Game(id, (e: Event) => {
      // broadcast to all sockets in that game
      for (const [ws, meta] of sockets) {
        if (meta.gameId === id && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(e));
        }
      }
    });
    games.set(id, g);
  }
  return games.get(id)!;
}

wss.on("connection", (ws) => {
  ws.on("message", (buf) => {
    const msg = safeParse(buf.toString());
    if (!msg) return;

    if (msg.type === "join") {
      const { gameId, name } = msg;
      const playerId = nanoid(8);
      const game = ensureGame(gameId || "demo");
      sockets.set(ws, { gameId: game.id, playerId });
      game.addPlayer(playerId, name || `P-${playerId}`);
      ws.send(JSON.stringify({ type: "joined", playerId, gameId: game.id }));
      return;
    }

    const meta = sockets.get(ws);
    if (!meta) return;

    const game = games.get(meta.gameId);
    if (!game) return;

    if (msg.type === "draw") game.draw(meta.playerId);
    if (msg.type === "slap") game.slap(meta.playerId);
  });

  ws.on("close", () => {
    const meta = sockets.get(ws);
    if (meta) {
      const game = games.get(meta.gameId);
      game?.setDisconnected(meta.playerId);
      sockets.delete(ws);
    }
  });
});

function safeParse(s: string) { try { return JSON.parse(s); } catch { return null; } }
