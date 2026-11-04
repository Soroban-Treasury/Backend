import { DatabaseSync } from "node:sqlite";
import type { DomainEvent } from "./events.js";

export type ProposalStatus = "open" | "executed" | "expired";

export interface ProposalRecord {
  treasuryId: string;
  id: number;
  proposer: string;
  asset: string;
  to: string;
  amount: string;
  approvals: string[];
  executed: boolean;
  /** Unix seconds. */
  expiresAt: number;
  status: ProposalStatus;
  createdLedger: number;
  createdAt: string;
  executedAt: string | null;
  executedTx: string | null;
}

export interface TreasuryRecord {
  id: string;
  owners: string[];
  threshold: number;
}

export interface AuditEntry {
  seq: number;
  treasuryId: string;
  type: string;
  proposalId: number | null;
  data: unknown;
  ledger: number;
  txHash: string;
  at: string;
}

export interface EventMeta {
  eventId: string;
  ledger: number;
  txHash: string;
  /** ISO time the ledger closed. */
  at: string;
}

export interface ListParams {
  limit?: number;
  offset?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS treasuries (
  id TEXT PRIMARY KEY,
  owners TEXT NOT NULL DEFAULT '[]',
  threshold INTEGER NOT NULL DEFAULT 0,
  cursor TEXT
);
CREATE TABLE IF NOT EXISTS proposals (
  treasury_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  proposer TEXT NOT NULL,
  asset TEXT NOT NULL,
  recipient TEXT NOT NULL,
  amount TEXT NOT NULL,
  approvals TEXT NOT NULL,
  executed INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_ledger INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  executed_at TEXT,
  executed_tx TEXT,
  PRIMARY KEY (treasury_id, id)
);
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  treasury_id TEXT NOT NULL,
  type TEXT NOT NULL,
  proposal_id INTEGER,
  data TEXT NOT NULL,
  ledger INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_by_treasury ON audit_log (treasury_id, seq);
`;

type Row = Record<string, unknown>;

/** SQLite storage for proposals, treasuries, indexer cursors and the audit log. */
export class Db {
  private readonly sql: DatabaseSync;

  constructor(path: string) {
    this.sql = new DatabaseSync(path);
    this.sql.exec("PRAGMA journal_mode = WAL;");
    this.sql.exec(SCHEMA);
  }

  close(): void {
    this.sql.close();
  }

  ensureTreasury(id: string): void {
    this.sql.prepare("INSERT OR IGNORE INTO treasuries (id) VALUES (?)").run(id);
  }

  getTreasury(id: string): TreasuryRecord | undefined {
    const row = this.sql.prepare("SELECT * FROM treasuries WHERE id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      owners: JSON.parse(String(row.owners)) as string[],
      threshold: Number(row.threshold),
    };
  }

  getCursor(treasuryId: string): string | undefined {
    const row = this.sql.prepare("SELECT cursor FROM treasuries WHERE id = ?").get(treasuryId) as Row | undefined;
    return row?.cursor ? String(row.cursor) : undefined;
  }

  setCursor(treasuryId: string, cursor: string): void {
    this.ensureTreasury(treasuryId);
    this.sql.prepare("UPDATE treasuries SET cursor = ? WHERE id = ?").run(cursor, treasuryId);
  }

  /**
   * Record an event in the audit log and update the proposals it affects, in one transaction.
   * Returns `false` (and changes nothing) if the event was already applied.
   */
  applyEvent(treasuryId: string, event: DomainEvent, meta: EventMeta): boolean {
    this.sql.exec("BEGIN");
    try {
      this.ensureTreasury(treasuryId);
      const inserted = this.sql
        .prepare(
          `INSERT OR IGNORE INTO audit_log (event_id, treasury_id, type, proposal_id, data, ledger, tx_hash, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          meta.eventId,
          treasuryId,
          event.type,
          "id" in event ? event.id : null,
          JSON.stringify(event),
          meta.ledger,
          meta.txHash,
          meta.at,
        );
      if (inserted.changes === 0) {
        this.sql.exec("ROLLBACK");
        return false;
      }
      this.updateState(treasuryId, event, meta);
      this.sql.exec("COMMIT");
      return true;
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }

  private updateState(treasuryId: string, event: DomainEvent, meta: EventMeta): void {
    switch (event.type) {
      case "initialized":
        this.sql
          .prepare("UPDATE treasuries SET owners = ?, threshold = ? WHERE id = ?")
          .run(JSON.stringify(event.owners), event.threshold, treasuryId);
        break;
      case "proposed":
        this.sql
          .prepare(
            `INSERT OR IGNORE INTO proposals
             (treasury_id, id, proposer, asset, recipient, amount, approvals, expires_at, created_ledger, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            treasuryId,
            event.id,
            event.proposer,
            event.asset,
            event.to,
            event.amount,
            JSON.stringify([event.proposer]),
            event.expiresAt,
            meta.ledger,
            meta.at,
          );
        break;
      case "approved": {
        const row = this.sql
          .prepare("SELECT approvals FROM proposals WHERE treasury_id = ? AND id = ?")
          .get(treasuryId, event.id) as Row | undefined;
        if (!row) break;
        const approvals = JSON.parse(String(row.approvals)) as string[];
        if (!approvals.includes(event.owner)) approvals.push(event.owner);
        this.sql
          .prepare("UPDATE proposals SET approvals = ? WHERE treasury_id = ? AND id = ?")
          .run(JSON.stringify(approvals), treasuryId, event.id);
        break;
      }
      case "executed":
        this.sql
          .prepare(
            "UPDATE proposals SET executed = 1, executed_at = ?, executed_tx = ? WHERE treasury_id = ? AND id = ?",
          )
          .run(meta.at, meta.txHash, treasuryId, event.id);
        break;
      default:
        // limit_set and limit_removed are only kept in the audit log.
        break;
    }
  }

  getProposal(treasuryId: string, id: number, nowSeconds = Math.floor(Date.now() / 1000)): ProposalRecord | undefined {
    const row = this.sql
      .prepare("SELECT * FROM proposals WHERE treasury_id = ? AND id = ?")
      .get(treasuryId, id) as Row | undefined;
    return row ? toProposal(row, nowSeconds) : undefined;
  }

  /** Proposals newest first. `status` is worked out at `nowSeconds`. */
  listProposals(
    treasuryId: string,
    params: ListParams & { status?: ProposalStatus; nowSeconds?: number } = {},
  ): { proposals: ProposalRecord[]; total: number } {
    const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
    const where = ["treasury_id = ?"];
    const args: (string | number)[] = [treasuryId];
    if (params.status === "executed") where.push("executed = 1");
    if (params.status === "open") {
      where.push("executed = 0 AND expires_at >= ?");
      args.push(now);
    }
    if (params.status === "expired") {
      where.push("executed = 0 AND expires_at < ?");
      args.push(now);
    }
    const clause = where.join(" AND ");
    const total = Number(
      (this.sql.prepare(`SELECT COUNT(*) AS n FROM proposals WHERE ${clause}`).get(...args) as Row).n,
    );
    const rows = this.sql
      .prepare(`SELECT * FROM proposals WHERE ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, params.limit ?? 50, params.offset ?? 0) as Row[];
    return { proposals: rows.map((r) => toProposal(r, now)), total };
  }

  /** Audit log entries, newest first. */
  auditLog(treasuryId: string, params: ListParams = {}): { entries: AuditEntry[]; total: number } {
    const total = Number(
      (this.sql.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE treasury_id = ?").get(treasuryId) as Row).n,
    );
    const rows = this.sql
      .prepare("SELECT * FROM audit_log WHERE treasury_id = ? ORDER BY seq DESC LIMIT ? OFFSET ?")
      .all(treasuryId, params.limit ?? 50, params.offset ?? 0) as Row[];
    return {
      total,
      entries: rows.map((r) => ({
        seq: Number(r.seq),
        treasuryId: String(r.treasury_id),
        type: String(r.type),
        proposalId: r.proposal_id === null ? null : Number(r.proposal_id),
        data: JSON.parse(String(r.data)) as unknown,
        ledger: Number(r.ledger),
        txHash: String(r.tx_hash),
        at: String(r.at),
      })),
    };
  }
}

function toProposal(row: Row, nowSeconds: number): ProposalRecord {
  const executed = Number(row.executed) === 1;
  const expiresAt = Number(row.expires_at);
  return {
    treasuryId: String(row.treasury_id),
    id: Number(row.id),
    proposer: String(row.proposer),
    asset: String(row.asset),
    to: String(row.recipient),
    amount: String(row.amount),
    approvals: JSON.parse(String(row.approvals)) as string[],
    executed,
    expiresAt,
    status: executed ? "executed" : expiresAt < nowSeconds ? "expired" : "open",
    createdLedger: Number(row.created_ledger),
    createdAt: String(row.created_at),
    executedAt: row.executed_at ? String(row.executed_at) : null,
    executedTx: row.executed_tx ? String(row.executed_tx) : null,
  };
}
