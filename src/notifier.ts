import { createHmac } from "node:crypto";
import type { ProposalRecord } from "./db.js";

export type NotificationKind =
  /** A new payment was proposed. Owners who have not approved yet should look at it. */
  | "proposal_created"
  /** Someone approved, but more approvals are still needed. */
  | "proposal_approved"
  /** The threshold is met. An owner can now execute. */
  | "proposal_ready"
  /** The payment was made. */
  | "proposal_executed";

export interface Notification {
  kind: NotificationKind;
  treasuryId: string;
  proposal: ProposalRecord;
  /** Owners who have not approved yet. Empty once everyone has. */
  pendingApprovers: string[];
  threshold: number;
}

/**
 * Something that delivers notifications. A notifier that throws is logged and skipped;
 * it never stops indexing.
 */
export interface Notifier {
  notify(notification: Notification): Promise<void>;
}

export interface WebhookOptions {
  /** Signs the body with HMAC-SHA256 in the `x-treasury-signature` header (`sha256=<hex>`). */
  secret?: string;
  /** Total tries per notification. Default 3. */
  attempts?: number;
  /** Wait before a retry, doubled each time. Default 500 ms. */
  retryDelayMs?: number;
  /** Request timeout. Default 10 s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Posts each notification as JSON to a URL. */
export class WebhookNotifier implements Notifier {
  private readonly attempts: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly url: string,
    private readonly options: WebhookOptions = {},
  ) {
    this.attempts = options.attempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async notify(notification: Notification): Promise<void> {
    const body = JSON.stringify(notification);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.secret) {
      headers["x-treasury-signature"] =
        "sha256=" + createHmac("sha256", this.options.secret).update(body).digest("hex");
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) return;
        lastError = new Error(`Webhook responded with HTTP ${res.status}`);
        // Client errors will not get better by retrying (except rate limits and timeouts).
        if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408) break;
      } catch (error) {
        lastError = error;
      }
      if (attempt < this.attempts) await sleep(this.retryDelayMs * 2 ** (attempt - 1));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

// TODO(wave: api-1): email notifier
// TODO(wave: api-2): Slack / Discord notifier

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
