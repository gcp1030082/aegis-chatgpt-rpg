import { loadConfig } from "./config.js";
import { startHttpServer } from "./http.js";
import { AegisService } from "./service.js";
import { createStore } from "./storage/index.js";

const config = loadConfig();
const store = createStore(config);
await store.initialize();
const service = new AegisService(store, config);
await startHttpServer(config, service, store);
