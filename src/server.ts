import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { StrKey } from "@stellar/stellar-sdk";
import type { Db, ProposalStatus } from "./db.js";

const STATUSES: ProposalStatus[] = ["open", "executed", "expired"];
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

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
 */
export function createApi(db: Db, treasuryIds: string[], options: { corsOrigin?: string } = {}): Server {
  const tracked = new Set(treasuryIds);

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
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
    }

    throw new HttpError(404, "Not found.");
  };

  return createServer((req, res) => {
    if (options.corsOrigin) {
      res.setHeader("access-control-allow-origin", options.corsOrigin);
      res.setHeader("vary", "origin");
    }
    try {
      handle(req, res);
    } catch (error) {
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
      console.error(error);
      sendJson(res, 500, { error: "Internal server error." });
    }
  });
}
