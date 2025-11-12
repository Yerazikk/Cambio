let ws: WebSocket | null = null;
const log = (x: any) => {
  const el = document.getElementById("log")!;
  el.textContent = `${el.textContent}\n${typeof x === 'string' ? x : JSON.stringify(x)}`;
};

document.getElementById("join")!.addEventListener("click", () => {
  const name = (document.getElementById("name") as HTMLInputElement).value || "Guest";
  const gameId = (document.getElementById("game") as HTMLInputElement).value || "demo";

  // Use VITE_WS_URL from environment variable, or fallback to local development
  const wsUrl = import.meta.env.VITE_WS_URL ||
    ((location.protocol === "https:" ? "wss" : "ws") + "://" + location.host.replace(":5173", ":8080"));

  ws = new WebSocket(wsUrl);
  ws.onopen = () => ws!.send(JSON.stringify({ type: "join", gameId, name }));
  ws.onmessage = (ev) => log(JSON.parse(ev.data));
  ws.onclose = () => log("closed");
});

document.getElementById("draw")!.addEventListener("click", () => {
  ws?.send(JSON.stringify({ type: "draw" }));
});
document.getElementById("slap")!.addEventListener("click", () => {
  ws?.send(JSON.stringify({ type: "slap" }));
});
