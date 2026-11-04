import { StrKey } from "@stellar/stellar-sdk";

export interface AppConfig {
  rpcUrl: string;
  networkPassphrase: string;
  /** Treasury contract ids to index. */
  treasuryIds: string[];
  dbPath: string;
  port: number;
  pollIntervalMs: number;
  /** First ledger to read when a treasury has no saved cursor. Default: about a day back. */
  startLedger?: number;
  webhookUrl?: string;
  /** If set, webhook bodies are signed with HMAC-SHA256 in the `x-treasury-signature` header. */
  webhookSecret?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

function int(name: string, value: string | undefined, fallback: number, min: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${name} must be an integer >= ${min}.`);
  return n;
}

/** Read settings from environment variables. Throws {@link ConfigError} on bad values. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const rpcUrl = env.RPC_URL;
  if (!rpcUrl) throw new ConfigError("RPC_URL is required.");
  try {
    new URL(rpcUrl);
  } catch {
    throw new ConfigError("RPC_URL must be a valid URL.");
  }

  const treasuryIds = (env.TREASURY_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (treasuryIds.length === 0) throw new ConfigError("TREASURY_IDS is required (comma-separated contract ids).");
  for (const id of treasuryIds) {
    if (!StrKey.isValidContract(id)) throw new ConfigError(`Not a valid contract id: ${id}`);
  }

  const webhookUrl = env.WEBHOOK_URL || undefined;
  if (webhookUrl) {
    try {
      new URL(webhookUrl);
    } catch {
      throw new ConfigError("WEBHOOK_URL must be a valid URL.");
    }
  }

  return {
    rpcUrl,
    networkPassphrase: env.NETWORK_PASSPHRASE || TESTNET_PASSPHRASE,
    treasuryIds: [...new Set(treasuryIds)],
    dbPath: env.DB_PATH || "treasury.db",
    port: int("PORT", env.PORT, 3000, 1),
    pollIntervalMs: int("POLL_INTERVAL_MS", env.POLL_INTERVAL_MS, 5000, 100),
    startLedger: env.START_LEDGER ? int("START_LEDGER", env.START_LEDGER, 0, 1) : undefined,
    webhookUrl,
    webhookSecret: env.WEBHOOK_SECRET || undefined,
  };
}
