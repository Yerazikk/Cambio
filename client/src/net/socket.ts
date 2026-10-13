import type { ClientMsg, ServerEvent } from "@cambio/shared";

/**
 * The session token is kept in sessionStorage rather than localStorage on
 * purpose: it is scoped to one tab, so two tabs on the same machine are two
 * different players. That is what makes local multiplayer testing work, and it
 * is also the right semantics - a seat belongs to a tab, not to a browser.
 */
const TOKEN_KEY = "cambio.token";

export function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* a private window with storage blocked still plays, it just cannot resume */
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to do */
  }
}

export type ConnectionStatus = "connecting" | "open" | "closed";

export type SocketHandlers = {
  onEvent: (event: ServerEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
};

export type Connection = {
  send: (msg: ClientMsg) => void;
  close: () => void;
};

/**
 * The server serves this page, so the socket always goes back to the same
 * origin. There is deliberately no configurable URL: a build that points at the
 * wrong host is a whole class of bug this removes.
 */
function socketUrl(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws`;
}

export function connect(handlers: SocketHandlers): Connection {
  let socket: WebSocket | null = null;
  let closedByUs = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Messages produced before the socket opened, replayed once it does. */
  const queue: ClientMsg[] = [];

  const open = (): void => {
    handlers.onStatus("connecting");
    const next = new WebSocket(socketUrl());
    socket = next;

    next.onopen = () => {
      attempt = 0;
      handlers.onStatus("open");

      // Reclaim the seat first, so a refresh lands the player back at the table
      // before anything else is sent.
      const token = readToken();
      if (token !== null) next.send(JSON.stringify({ t: "room.resume", token } satisfies ClientMsg));

      while (queue.length > 0) {
        const msg = queue.shift();
        if (msg) next.send(JSON.stringify(msg));
      }
    };

    next.onmessage = (event) => {
      let parsed: ServerEvent;
      try {
        parsed = JSON.parse(String(event.data)) as ServerEvent;
      } catch {
        return;
      }
      // Answer latency probes immediately and without comment: the round trip
      // the server measures here is what makes snap races fair.
      if (parsed.t === "ping") {
        next.send(JSON.stringify({ t: "pong", nonce: parsed.nonce } satisfies ClientMsg));
        return;
      }
      if (parsed.t === "hello") writeToken(parsed.token);
      handlers.onEvent(parsed);
    };

    next.onclose = () => {
      socket = null;
      handlers.onStatus("closed");
      if (closedByUs) return;

      attempt += 1;
      const backoff = Math.min(500 * 2 ** (attempt - 1), 5_000);
      retryTimer = setTimeout(open, backoff);
    };

    next.onerror = () => {
      /* onclose always follows, and handles the retry */
    };
  };

  open();

  return {
    send: (msg) => {
      if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
      else queue.push(msg);
    },
    close: () => {
      closedByUs = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      socket?.close();
    },
  };
}
