import { Keypair, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { RawEvent } from "../src/events.js";
import type { EventPage, EventSource } from "../src/indexer.js";

export const TREASURY = StrKey.encodeContract(Buffer.alloc(32, 1));
export const OTHER_TREASURY = StrKey.encodeContract(Buffer.alloc(32, 9));
export const ASSET = StrKey.encodeContract(Buffer.alloc(32, 2));
export const owners = [Keypair.random().publicKey(), Keypair.random().publicKey(), Keypair.random().publicKey()];
export const recipient = Keypair.random().publicKey();

type Typed = { v: unknown; t: string };
const address = (v: string): Typed => ({ v, t: "address" });
const u64 = (v: number): Typed => ({ v: BigInt(v), t: "u64" });
const i128 = (v: number | bigint): Typed => ({ v: BigInt(v), t: "i128" });
const u32 = (v: number): Typed => ({ v, t: "u32" });

const scv = ({ v, t }: Typed): xdr.ScVal => nativeToScVal(v as never, { type: t } as never);

/** Build a map ScVal the way a Soroban `#[contractevent]` does: symbol keys sorted by name. */
function dataMap(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: fields[k]! })),
  );
}

let counter = 0;

export function rawEvent(
  name: string,
  topics: xdr.ScVal[],
  data: Record<string, xdr.ScVal>,
  extra: Partial<RawEvent> = {},
): RawEvent {
  counter++;
  return {
    id: `evt-${String(counter).padStart(6, "0")}`,
    ledger: 100 + counter,
    ledgerClosedAt: `2026-11-04T00:00:${String(counter % 60).padStart(2, "0")}Z`,
    txHash: `tx${counter}`,
    topic: [xdr.ScVal.scvSymbol(name), ...topics],
    value: dataMap(data),
    ...extra,
  };
}

export const events = {
  initialized: (ownerList = owners, threshold = 2) =>
    rawEvent("initialized", [], {
      owners: xdr.ScVal.scvVec(ownerList.map((o) => scv(address(o)))),
      threshold: scv(u32(threshold)),
    }),
  proposed: (id: number, proposer = owners[0]!, amount: number | bigint = 500, expiresAt = 4_000_000_000) =>
    rawEvent("proposed", [scv(u64(id))], {
      proposer: scv(address(proposer)),
      asset: scv(address(ASSET)),
      to: scv(address(recipient)),
      amount: scv(i128(amount)),
      expires_at: scv(u64(expiresAt)),
    }),
  approved: (id: number, owner: string, approvals: number) =>
    rawEvent("approved", [scv(u64(id))], { owner: scv(address(owner)), approvals: scv(u32(approvals)) }),
  executed: (id: number, executor = owners[0]!, amount = 500) =>
    rawEvent("executed", [scv(u64(id))], {
      executor: scv(address(executor)),
      asset: scv(address(ASSET)),
      to: scv(address(recipient)),
      amount: scv(i128(amount)),
    }),
  limitSet: () =>
    rawEvent("limit_set", [scv(address(ASSET))], { limit: scv(i128(1000)), period: scv(u64(86400)) }),
  limitRemoved: () => rawEvent("limit_removed", [scv(address(ASSET))], {}),
};

/** An event source that serves queued events page by page and remembers what it was asked. */
export class FakeSource implements EventSource {
  readonly requests: { contractId: string; startLedger?: number; cursor?: string; limit: number }[] = [];
  private readonly queue = new Map<string, RawEvent[]>();
  private readonly served = new Map<string, number>();
  latest = 1_000_000;
  failFor = new Set<string>();

  push(contractId: string, ...evts: RawEvent[]): void {
    this.queue.set(contractId, [...(this.queue.get(contractId) ?? []), ...evts]);
  }

  async getLatestLedger(): Promise<number> {
    return this.latest;
  }

  async getEvents(params: {
    contractId: string;
    startLedger?: number;
    cursor?: string;
    limit: number;
  }): Promise<EventPage> {
    this.requests.push(params);
    if (this.failFor.has(params.contractId)) throw new Error("rpc down");
    const all = this.queue.get(params.contractId) ?? [];
    // The cursor is just the number of events served so far.
    const from = params.cursor ? Number(params.cursor) : 0;
    const events = all.slice(from, from + params.limit);
    const next = from + events.length;
    this.served.set(params.contractId, next);
    return { events, cursor: String(next) };
  }
}
