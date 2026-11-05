import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { Indexer, RpcEventSource } from "./indexer.js";
import { WebhookNotifier } from "./notifier.js";
import { createApi } from "./server.js";

const config = loadConfig();
const db = new Db(config.dbPath);

const notifier = config.webhookUrl
  ? new WebhookNotifier(config.webhookUrl, { secret: config.webhookSecret })
  : undefined;

const indexer = new Indexer({
  db,
  source: new RpcEventSource(config.rpcUrl),
  treasuryIds: config.treasuryIds,
  notifier,
  startLedger: config.startLedger,
  pollIntervalMs: config.pollIntervalMs,
});

const server = createApi(db, config.treasuryIds, { corsOrigin: config.corsOrigin });
server.listen(config.port, () => {
  console.log(`API listening on :${config.port}, indexing ${config.treasuryIds.length} treasury(ies)`);
});

const abort = new AbortController();
const indexing = indexer.run(abort.signal);

function shutdown(): void {
  abort.abort();
  server.close();
  void indexing.finally(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
