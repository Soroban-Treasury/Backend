import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { StrKey } from "@stellar/stellar-sdk";
import type { AuditEntry, Db, ProposalStatus } from "./db.js";

const STATUSES: ProposalStatus[] = ["open", "executed", "expired"];
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const AUDIT_CSV_COLUMNS = [
  "seq",
  "at",
  "ledger",
  "tx_hash",
  "treasury_id",
  "type",
  "proposal_id",
  "actor",
  "asset",
  "to",
  "amount",
  "limit",
  "period_seconds",
  "approvals",
  "threshold",
  "expires_at",
  "data",
] as const;

/** Escape a CSV field per RFC 4180 (commas, double quotes, CR and LF). */
export function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (text.includes(",") || text.includes('"') || text.includes("\n") || text.includes("\r")) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function toIso8601(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") {
    const ms = value * 1000;
    if (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15) return new Date(ms).toISOString();
    return String(value);
  }
  const text = String(value);
  if (ISO_8601_RE.test(text)) return text;
  if (/^-?\d+$/.test(text)) {
    const ms = Number(text) * 1000;
    if (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15) return new Date(ms).toISOString();
  }
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return text;
}

function exactText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function formatAuditCsvRow(entry: AuditEntry): string {
  const data =
    typeof entry.data === "object" && entry.data !== null
      ? (entry.data as Record<string, unknown>)
      : {};
  const actor =
    typeof data.proposer === "string"
      ? data.proposer
      : typeof data.owner === "string"
        ? data.owner
        : typeof data.executor === "string"
          ? data.executor
          : "";
  const cells: (string | number | null)[] = [
    entry.seq,
    toIso8601(entry.at),
    entry.ledger,
    entry.txHash,
    entry.treasuryId,
    entry.type,
    entry.proposalId,
    actor,
    typeof data.asset === "string" ? data.asset : "",
    typeof data.to === "string" ? data.to : "",
    exactText(data.amount),
    exactText(data.limit),
    exactText(data.period),
    exactText(data.approvals),
    exactText(data.threshold),
    data.expiresAt !== undefined ? toIso8601(data.expiresAt) : "",
    JSON.stringify(entry.data ?? null),
  ];
  return cells.map(escapeCsvField).join(",");
}

async function streamAuditLogCsv(
  res: ServerResponse,
  db: Db,
  treasuryId: string,
  pageSize: number,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="audit-log-${treasuryId}.csv"`,
  });
  res.write(`${AUDIT_CSV_COLUMNS.join(",")}\n`);

  let afterSeq = 0;
  for (;;) {
    if (res.destroyed || res.writableEnded) return;
    const page = db.auditLogPageAfter(treasuryId, afterSeq, pageSize);
    if (page.length === 0) break;
    const chunk = page.map((entry) => `${formatAuditCsvRow(entry)}\n`).join("");
    if (!res.write(chunk) && !res.destroyed) {
      await once(res, "drain");
    }
    afterSeq = page[page.length - 1]!.seq;
    if (page.length < pageSize) break;
  }
  if (!res.writableEnded) res.end();
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${name} must be an integer between ${min} and ${max}.`);
  }
  return n;
}

/**
 * HTTP API:
 *
 * - `GET /health`
 * - `GET /treasuries/:id/proposals?status=open|executed|expired&limit=&offset=`
 * - `GET /treasuries/:id/proposals/:proposalId`
 * - `GET /treasuries/:id/audit-log?limit=&offset=`
 * - `GET /treasuries/:id/audit-log.csv`
 */
/**
 * The CORS header for a request. `allowed` is one origin, a comma-separated list, or `*`.
 * A request from a listed origin gets that origin back; one without an Origin header gets the first listed.
 */
export function corsHeaderFor(allowed: string | undefined, requestOrigin: string | undefined): string | null {
  if (!allowed) return null;
  const origins = allowed
    .split(",")
    .map((o) => (o.trim().endsWith("/") ? o.trim().slice(0, -1) : o.trim()))
    .filter(Boolean);
  if (origins.includes("*")) return "*";
  if (!requestOrigin) return origins[0] ?? null;
  return origins.includes(requestOrigin) ? requestOrigin : null;
}

export function createApi(
  db: Db,
  treasuryIds: string[],
  options: { corsOrigin?: string; csvPageSize?: number } = {},
): Server {
  const tracked = new Set(treasuryIds);
  const csvPageSize = Math.max(1, options.csvPageSize ?? MAX_LIMIT);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "GET") throw new HttpError(405, "Only GET is supported.");
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length === 1 && parts[0] === "health") return sendJson(res, 200, { status: "ok" });

    if (parts[0] === "treasuries" && parts[1]) {
      const treasuryId = decodeURIComponent(parts[1]);
      if (!StrKey.isValidContract(treasuryId)) throw new HttpError(400, "Not a valid treasury contract id.");
      if (!tracked.has(treasuryId)) throw new HttpError(404, "This treasury is not indexed.");

      if (parts[2] === "proposals" && parts.length === 3) {
        const status = url.searchParams.get("status");
        if (status !== null && !STATUSES.includes(status as ProposalStatus)) {
          throw new HttpError(400, `status must be one of: ${STATUSES.join(", ")}.`);
        }
        const limit = intParam(url, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
        const offset = intParam(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
        const { proposals, total } = db.listProposals(treasuryId, {
          status: (status as ProposalStatus | null) ?? undefined,
          limit,
          offset,
        });
        return sendJson(res, 200, { treasuryId, total, limit, offset, proposals });
      }

      if (parts[2] === "proposals" && parts.length === 4) {
        const id = Number(parts[3]);
        if (!Number.isInteger(id) || id < 0) throw new HttpError(400, "Proposal id must be a whole number.");
        const proposal = db.getProposal(treasuryId, id);
        if (!proposal) throw new HttpError(404, "Proposal not found.");
        return sendJson(res, 200, proposal);
      }

      if (parts[2] === "audit-log" && parts.length === 3) {
        const limit = intParam(url, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
        const offset = intParam(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
        const { entries, total } = db.auditLog(treasuryId, { limit, offset });
        return sendJson(res, 200, { treasuryId, total, limit, offset, entries });
      }

      if (parts[2] === "audit-log.csv" && parts.length === 3) {
        return streamAuditLogCsv(res, db, treasuryId, csvPageSize);
      }
    }

    throw new HttpError(404, "Not found.");
  };

  return createServer((req, res) => {
    const allowOrigin = corsHeaderFor(options.corsOrigin, req.headers.origin);
    if (allowOrigin) res.setHeader("access-control-allow-origin", allowOrigin);
    if (options.corsOrigin) res.setHeader("vary", "origin");
    void handle(req, res).catch((error) => {
      if (res.headersSent) {
        console.error(error);
        res.destroy();
        return;
      }
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
      console.error(error);
      sendJson(res, 500, { error: "Internal server error." });
    });
  });
}
