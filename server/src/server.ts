import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import { nanoid } from "nanoid";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ROOM_REAP_IDLE_MS,
  RTT_PING_INTERVAL_MS,
  type ClientMsg,
  type RuleConfig,
  type ServerEvent,
} from "@cambio/shared";
import { createGateway, type Gateway } from "./gateway.js";
import { systemRng, type Rng } from "./rng.js";
import { RoomManager } from "./rooms.js";

export type StartOptions = {
  port?: number;
  rng?: Rng;
  now?: () => number;
  newId?: () => string;
  rules?: Partial<RuleConfig>;
  /** Override how long a dropped player's seat is held. */
  graceMs?: { inGame?: number; lobby?: number };
  /** Latency probing and room reaping are off by default in tests. */
  pingIntervalMs?: number | null;
  reapIntervalMs?: number | null;
  /** Where the built client lives; omitted in tests. */
  clientDist?: string | null;
};

export type RunningServer = {
  server: Server;
  manager: RoomManager;
  gateway: Gateway<WebSocket>;
  port: number;
  url: string;
  close: () => Promise<void>;
};

const defaultClientDist = (): string => fileURLToPath(new URL("../../client/dist", import.meta.url));

export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const app = express();
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  /**
   * The built client is served from this same process, so the page and its
   * socket always share an origin. That is what removes the need for the client
   * to know a server URL at all.
   */
  const clientDist = options.clientDist === null ? null : (options.clientDist ?? defaultClientDist());
  if (clientDist !== null) {
    app.use(express.static(clientDist));
    // Single-page fallback: anything unmatched is handed to the client.
    app.use((_req, res) => {
      res.sendFile(`${clientDist}/index.html`, (error) => {
        if (error) res.status(404).type("text/plain").send("client build not found; run npm run build");
      });
    });
  }

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  const manager = new RoomManager({
    now: options.now ?? (() => Date.now()),
    rng: options.rng ?? systemRng,
    newId: options.newId ?? (() => nanoid(12)),
    ...(options.rules ? { rules: options.rules } : {}),
    ...(options.graceMs ? { graceMs: options.graceMs } : {}),
    onAsync: (code, out) => gateway.deliver(code, out),
  });

  const gateway = createGateway<WebSocket>({
    manager,
    send: (socket, event) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    },
  });

  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const msg = parseMessage(raw.toString());
      if (msg === null) {
        gateway.sendTo(socket, { t: "error", code: "malformed", message: "could not read that message" });
        return;
      }
      gateway.handle(socket, msg);
    });
    socket.on("close", () => gateway.drop(socket));
    socket.on("error", () => gateway.drop(socket));
  });

  const timers: NodeJS.Timeout[] = [];
  const pingMs = options.pingIntervalMs === undefined ? RTT_PING_INTERVAL_MS : options.pingIntervalMs;
  if (pingMs !== null) {
    // Measuring latency ourselves is what makes the snap race fair.
    timers.push(setInterval(() => gateway.pingAll(), pingMs));
  }
  const reapMs = options.reapIntervalMs === undefined ? Math.min(ROOM_REAP_IDLE_MS, 60_000) : options.reapIntervalMs;
  if (reapMs !== null) {
    timers.push(setInterval(() => manager.reapIdleRooms(), reapMs));
  }
  for (const timer of timers) timer.unref();

  const port = await listen(server, options.port ?? 0);

  return {
    server,
    manager,
    gateway,
    port,
    url: `ws://127.0.0.1:${port}/ws`,
    close: async () => {
      for (const timer of timers) clearInterval(timer);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

export function parseMessage(text: string): ClientMsg | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { t?: unknown }).t === "string") {
      return parsed as ClientMsg;
    }
    return null;
  } catch {
    return null;
  }
}

export type { ServerEvent };
