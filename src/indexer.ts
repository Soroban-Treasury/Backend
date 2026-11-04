import { rpc } from "@stellar/stellar-sdk";
import type { Db } from "./db.js";
import { decodeEvent } from "./events.js";
import type { DomainEvent, RawEvent } from "./events.js";
import type { Notification, Notifier } from "./notifier.js";

export interface EventPage {
  events: RawEvent[];
  /** Pass this back to get the next page. */
  cursor: string;
}

/** Where events come from. The real one is {@link RpcEventSource}; tests pass a fake. */
export interface EventSource {
  getLatestLedger(): Promise<number>;
  getEvents(params: {
    contractId: string;
    startLedger?: number;
    cursor?: string;
    limit: number;
  }): Promise<EventPage>;
}

export class RpcEventSource implements EventSource {
  private readonly server: rpc.Server;

  constructor(rpcUrl: string, allowHttp = rpcUrl.startsWith("http://")) {
    this.server = new rpc.Server(rpcUrl, { allowHttp });
  }

  async getLatestLedger(): Promise<number> {
    return (await this.server.getLatestLedger()).sequence;
  }

  async getEvents(params: {
    contractId: string;
    startLedger?: number;
    cursor?: string;
    limit: number;
  }): Promise<EventPage> {
    const filters = [{ type: "contract" as const, contractIds: [params.contractId] }];
    const res = params.cursor
      ? await this.server.getEvents({ filters, cursor: params.cursor, limit: params.limit })
      : await this.server.getEvents({ filters, startLedger: params.startLedger ?? 1, limit: params.limit });
    return { events: res.events as unknown as RawEvent[], cursor: res.cursor };
  }
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface IndexerOptions {
  db: Db;
  source: EventSource;
  treasuryIds: string[];
  notifier?: Notifier;
  /** First ledger for a treasury with no saved cursor. Default: about a day back. */
  startLedger?: number;
  pollIntervalMs?: number;
  /** Events per request. Default 100. */
  pageSize?: number;
  logger?: Logger;
}

/** Most requests per treasury in one poll, so a busy or far-behind treasury cannot starve the others. */
const MAX_PAGES_PER_POLL = 200;

/** Roughly one day of ledgers at 5 s each. */
const DEFAULT_LOOKBACK_LEDGERS = 17_280;

/** Polls contract events and keeps the database up to date. */
export class Indexer {
  private readonly db: Db;
  private readonly source: EventSource;
  private readonly notifier?: Notifier;
  private readonly treasuryIds: string[];
  private readonly startLedger?: number;
  private readonly pollIntervalMs: number;
  private readonly pageSize: number;
  private readonly log: Logger;

  constructor(options: IndexerOptions) {
    this.db = options.db;
    this.source = options.source;
    this.notifier = options.notifier;
    this.treasuryIds = options.treasuryIds;
    this.startLedger = options.startLedger;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.pageSize = options.pageSize ?? 100;
    this.log = options.logger ?? console;
  }

  /** Poll every treasury once. Returns how many new events were stored. */
  async pollOnce(): Promise<number> {
    let stored = 0;
    for (const id of this.treasuryIds) {
      try {
        stored += await this.pollTreasury(id);
      } catch (error) {
        // One treasury failing (for example an RPC hiccup) must not stop the others.
        this.log.error(`Polling ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return stored;
  }

  /** Poll until `signal` is aborted. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.pollOnce();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.pollIntervalMs);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }

  private async pollTreasury(treasuryId: string): Promise<number> {
    this.db.ensureTreasury(treasuryId);
    let stored = 0;
    for (let pages = 0; pages < MAX_PAGES_PER_POLL; pages++) {
      const cursor = this.db.getCursor(treasuryId);
      const startLedger = cursor ? undefined : await this.firstLedger();
      const page = await this.source.getEvents({ contractId: treasuryId, cursor, startLedger, limit: this.pageSize });

      for (const raw of page.events) {
        const event = decodeEvent(raw);
        if (!event) {
          this.log.warn(`Skipping unknown event ${raw.id} from ${treasuryId}`);
          continue;
        }
        const isNew = this.db.applyEvent(treasuryId, event, {
          eventId: raw.id,
          ledger: raw.ledger,
          txHash: raw.txHash,
          at: raw.ledgerClosedAt,
        });
        if (isNew) {
          stored++;
          await this.notify(treasuryId, event);
        }
      }

      if (page.cursor) this.db.setCursor(treasuryId, page.cursor);
      if (!page.cursor) break;
      // A full page means there may be more. An empty page with a moved cursor means RPC scanned
      // a stretch of ledgers without finding events, so keep going until the cursor stops moving.
      const full = page.events.length >= this.pageSize;
      const scannedOn = page.events.length === 0 && page.cursor !== cursor;
      if (!full && !scannedOn) break;
    }
    return stored;
  }

  private async firstLedger(): Promise<number> {
    if (this.startLedger !== undefined) return this.startLedger;
    const latest = await this.source.getLatestLedger();
    return Math.max(1, latest - DEFAULT_LOOKBACK_LEDGERS);
  }

  private async notify(treasuryId: string, event: DomainEvent): Promise<void> {
    if (!this.notifier) return;
    const notification = this.buildNotification(treasuryId, event);
    if (!notification) return;
    try {
      await this.notifier.notify(notification);
    } catch (error) {
      this.log.warn(
        `Notification ${notification.kind} for proposal ${notification.proposal.id} failed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private buildNotification(treasuryId: string, event: DomainEvent): Notification | undefined {
    if (event.type !== "proposed" && event.type !== "approved" && event.type !== "executed") return undefined;
    const treasury = this.db.getTreasury(treasuryId);
    const proposal = this.db.getProposal(treasuryId, event.id);
    if (!treasury || !proposal) return undefined;

    const pendingApprovers = treasury.owners.filter((o) => !proposal.approvals.includes(o));
    let kind: Notification["kind"];
    if (event.type === "proposed") kind = "proposal_created";
    else if (event.type === "executed") kind = "proposal_executed";
    else kind = proposal.approvals.length >= treasury.threshold ? "proposal_ready" : "proposal_approved";

    return { kind, treasuryId, proposal, pendingApprovers, threshold: treasury.threshold };
  }
}
