import { loadConfig } from "./config.js";
import { createBridgeServer } from "./server.js";

const config = loadConfig();
const server = createBridgeServer(config);

server.listen(config.port, config.host, () => {
  console.log(`gpt-bridge-node listening on http://${config.host}:${config.port}`);
  console.log(`character-game=removed`);
});

function shutdown(signal: string): void {
  console.log(`received ${signal}, stopping server`);
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
