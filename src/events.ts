import { scValToNative } from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";

/** Events the treasury contract emits, decoded. Amounts are strings (i128 does not fit a JS number). */
export type DomainEvent =
  | { type: "initialized"; owners: string[]; threshold: number }
  | { type: "limit_set"; asset: string; limit: string; period: string }
  | { type: "limit_removed"; asset: string }
  | {
      type: "proposed";
      id: number;
      proposer: string;
      asset: string;
      to: string;
      amount: string;
      expiresAt: number;
    }
  | { type: "approved"; id: number; owner: string; approvals: number }
  | { type: "executed"; id: number; executor: string; asset: string; to: string; amount: string };

/** The parts of an RPC event this service reads. */
export interface RawEvent {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  topic: xdr.ScVal[];
  value: xdr.ScVal;
}

type Fields = Record<string, unknown>;

const str = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v);

/**
 * Turn a raw contract event into a {@link DomainEvent}.
 * Returns `undefined` for events this service does not know, so new contract events don't break indexing.
 *
 * Contract events look like: topics `[name, ...topic fields]`, data = map of the other fields.
 */
export function decodeEvent(raw: RawEvent): DomainEvent | undefined {
  const [nameVal, topic1] = raw.topic;
  if (!nameVal) return undefined;
  const name = scValToNative(nameVal);
  if (typeof name !== "string") return undefined;
  const topic = topic1 ? scValToNative(topic1) : undefined;
  const data = scValToNative(raw.value) as Fields | null;
  if (typeof data !== "object" || data === null) return undefined;

  switch (name) {
    case "initialized":
      return {
        type: "initialized",
        owners: (data.owners as unknown[]).map(str),
        threshold: num(data.threshold),
      };
    case "limit_set":
      return { type: "limit_set", asset: str(topic), limit: str(data.limit), period: str(data.period) };
    case "limit_removed":
      return { type: "limit_removed", asset: str(topic) };
    case "proposed":
      return {
        type: "proposed",
        id: num(topic),
        proposer: str(data.proposer),
        asset: str(data.asset),
        to: str(data.to),
        amount: str(data.amount),
        expiresAt: num(data.expires_at),
      };
    case "approved":
      return { type: "approved", id: num(topic), owner: str(data.owner), approvals: num(data.approvals) };
    case "executed":
      return {
        type: "executed",
        id: num(topic),
        executor: str(data.executor),
        asset: str(data.asset),
        to: str(data.to),
        amount: str(data.amount),
      };
    default:
      return undefined;
  }
}
