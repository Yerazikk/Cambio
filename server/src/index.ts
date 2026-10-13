import { startServer } from "./server.js";

const port = Number(process.env.PORT ?? 8080);

const running = await startServer({ port });
console.log(`cambio listening on :${running.port}`);

function shutdown(): void {
  void running.close();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
