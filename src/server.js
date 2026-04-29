import http from "node:http";

import { loadConfig } from "./config.js";
import { createRouter } from "./routes.js";
import { HeartbeatStore } from "./store.js";

const config = loadConfig();
const store = new HeartbeatStore(config.dataDir);

await store.init();

const server = http.createServer(createRouter({ config, store }));

server.listen(config.port, config.host, () => {
  console.log(`PiBoatServer listening on http://${config.host}:${config.port}`);
});
