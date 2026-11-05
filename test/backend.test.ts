import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { decodeEvent } from "../src/events.js";
import { Indexer } from "../src/indexer.js";
import { WebhookNotifier } from "../src/notifier.js";
import type { Notification } from "../src/notifier.js";
import { createApi } from "../src/server.js";
import { ASSET, FakeSource, OTHER_TREASURY, TREASURY, events, owners, recipient } from "./helpers.js";

const silent = { info() {}, warn() {}, error() {} };

describe("decodeEvent", () => {
  it("decodes each contract event", () => {
    expect(decodeEvent(events.initialized())).toEqual({ type: "initialized", owners, threshold: 2 });
    expect(decodeEvent(events.proposed(3, owners[0], 750, 5000))).toEqual({
      type: "proposed",
      id: 3,
      proposer: owners[0],
      asset: ASSET,
      to: recipient,
      amount: "750",
      expiresAt: 5000,
    });
    expect(decodeEvent(events.approved(3, owners[1]!, 2))).toEqual({
      type: "approved",
      id: 3,
      owner: owners[1],
      approvals: 2,
    });
    expect(decodeEvent(events.executed(3, owners[2], 750))).toMatchObject({ type: "executed", id: 3, amount: "750" });
    expect(decodeEvent(events.limitSet())).toEqual({ type: "limit_set", asset: ASSET, limit: "1000", period: "86400" });
    expect(decodeEvent(events.limitRemoved())).toEqual({ type: "limit_removed", asset: ASSET });
  });

  it("keeps big amounts exact", () => {
    const event = decodeEvent(events.proposed(0, owners[0], 2n ** 100n));
    expect(event).toMatchObject({ type: "proposed", amount: "1267650600228229401496703205376" });
  });

  it("ignores unknown events", () => {
    expect(decodeEvent({ ...events.limitRemoved(), topic: [] })).toBeUndefined();
  });
});

describe("Db", () => {
  let db: Db;
  beforeEach(() => {
    db = new Db(":memory:");
  });
  afterEach(() => db.close());

  const meta = (n: number) => ({ eventId: `e${n}`, ledger: n, txHash: `t${n}`, at: `2026-11-04T00:00:0${n}Z` });

  it("tracks a proposal from proposed to executed", () => {
    db.applyEvent(TREASURY, { type: "initialized", owners, threshold: 2 }, meta(1));
    db.applyEvent(
      TREASURY,
      { type: "proposed", id: 0, proposer: owners[0]!, asset: ASSET, to: recipient, amount: "500", expiresAt: 9_999_999_999 },
      meta(2),
    );
    expect(db.getProposal(TREASURY, 0)).toMatchObject({ approvals: [owners[0]], status: "open", executed: false });

    db.applyEvent(TREASURY, { type: "approved", id: 0, owner: owners[1]!, approvals: 2 }, meta(3));
    expect(db.getProposal(TREASURY, 0)?.approvals).toEqual([owners[0], owners[1]]);

    db.applyEvent(
      TREASURY,
      { type: "executed", id: 0, executor: owners[0]!, asset: ASSET, to: recipient, amount: "500" },
      meta(4),
    );
    expect(db.getProposal(TREASURY, 0)).toMatchObject({ status: "executed", executedTx: "t4" });
  });

  it("ignores an event it has already applied", () => {
    const event = { type: "approved", id: 0, owner: owners[1]!, approvals: 2 } as const;
    expect(db.applyEvent(TREASURY, event, meta(1))).toBe(true);
    expect(db.applyEvent(TREASURY, event, meta(1))).toBe(false);
    expect(db.auditLog(TREASURY).total).toBe(1);
  });

  it("derives expired status from the clock", () => {
    db.applyEvent(
      TREASURY,
      { type: "proposed", id: 0, proposer: owners[0]!, asset: ASSET, to: recipient, amount: "1", expiresAt: 1000 },
      meta(1),
    );
    expect(db.getProposal(TREASURY, 0, 999)?.status).toBe("open");
    expect(db.getProposal(TREASURY, 0, 1001)?.status).toBe("expired");
    expect(db.listProposals(TREASURY, { status: "expired", nowSeconds: 1001 }).total).toBe(1);
    expect(db.listProposals(TREASURY, { status: "open", nowSeconds: 1001 }).total).toBe(0);
  });

  it("lists newest first with paging, and keeps treasuries apart", () => {
    for (let i = 0; i < 5; i++) {
      db.applyEvent(
        TREASURY,
        { type: "proposed", id: i, proposer: owners[0]!, asset: ASSET, to: recipient, amount: "1", expiresAt: 9_999_999_999 },
        meta(i + 1),
      );
    }
    db.applyEvent(
      OTHER_TREASURY,
      { type: "proposed", id: 0, proposer: owners[0]!, asset: ASSET, to: recipient, amount: "1", expiresAt: 9_999_999_999 },
      { ...meta(9), eventId: "other" },
    );
    const page = db.listProposals(TREASURY, { limit: 2, offset: 1 });
    expect(page.total).toBe(5);
    expect(page.proposals.map((p) => p.id)).toEqual([3, 2]);
    expect(db.listProposals(OTHER_TREASURY).total).toBe(1);
  });

  it("keeps policy events only in the audit log", () => {
    db.applyEvent(TREASURY, { type: "limit_set", asset: ASSET, limit: "1000", period: "86400" }, meta(1));
    const { entries } = db.auditLog(TREASURY);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "limit_set", proposalId: null, txHash: "t1" });
  });
});

describe("Indexer", () => {
  let db: Db;
  let source: FakeSource;
  beforeEach(() => {
    db = new Db(":memory:");
    source = new FakeSource();
  });
  afterEach(() => db.close());

  const make = (extra: Partial<ConstructorParameters<typeof Indexer>[0]> = {}) =>
    new Indexer({ db, source, treasuryIds: [TREASURY], logger: silent, pageSize: 2, ...extra });

  it("stores events across pages and saves the cursor", async () => {
    source.push(
      TREASURY,
      events.initialized(),
      events.proposed(0),
      events.approved(0, owners[1]!, 2),
      events.executed(0),
      events.limitSet(),
    );
    const indexer = make();
    expect(await indexer.pollOnce()).toBe(5);
    expect(db.getProposal(TREASURY, 0)?.status).toBe("executed");
    expect(db.auditLog(TREASURY).total).toBe(5);
    expect(db.getCursor(TREASURY)).toBe("5");

    // Nothing new: the next poll resumes from the saved cursor.
    expect(await indexer.pollOnce()).toBe(0);
    expect(source.requests.at(-1)?.cursor).toBe("5");
  });

  it("starts about a day back when no start ledger is set, or at the given ledger", async () => {
    await make().pollOnce();
    expect(source.requests[0]?.startLedger).toBe(source.latest - 17_280);

    const db2 = new Db(":memory:");
    const source2 = new FakeSource();
    await new Indexer({ db: db2, source: source2, treasuryIds: [TREASURY], startLedger: 777, logger: silent }).pollOnce();
    expect(source2.requests[0]?.startLedger).toBe(777);
    db2.close();
  });

  it("does not store the same event twice if the cursor is lost", async () => {
    source.push(TREASURY, events.initialized(), events.proposed(0));
    const indexer = make();
    await indexer.pollOnce();
    db.setCursor(TREASURY, "0");
    expect(await indexer.pollOnce()).toBe(0);
    expect(db.auditLog(TREASURY).total).toBe(2);
  });

  it("skips unknown events", async () => {
    source.push(TREASURY, { ...events.limitRemoved(), topic: [] }, events.proposed(0));
    expect(await make().pollOnce()).toBe(1);
  });

  it("keeps going when one treasury fails", async () => {
    source.failFor.add(TREASURY);
    source.push(OTHER_TREASURY, events.initialized(), events.proposed(0));
    const indexer = make({ treasuryIds: [TREASURY, OTHER_TREASURY] });
    expect(await indexer.pollOnce()).toBe(2);
    expect(db.getProposal(OTHER_TREASURY, 0)).toBeDefined();
  });

  it("sends the right notifications", async () => {
    const sent: Notification[] = [];
    const notifier = { notify: async (n: Notification) => void sent.push(n) };
    source.push(
      TREASURY,
      events.initialized(),
      events.proposed(0),
      events.approved(0, owners[1]!, 2),
      events.executed(0),
    );
    await make({ notifier, pageSize: 10 }).pollOnce();

    expect(sent.map((n) => n.kind)).toEqual(["proposal_created", "proposal_ready", "proposal_executed"]);
    expect(sent[0]!.pendingApprovers).toEqual([owners[1], owners[2]]);
    expect(sent[1]!.pendingApprovers).toEqual([owners[2]]);
    expect(sent[0]!.threshold).toBe(2);
  });

  it("says approved, not ready, while below the threshold", async () => {
    const sent: Notification[] = [];
    source.push(
      TREASURY,
      events.initialized(owners, 3),
      events.proposed(0),
      events.approved(0, owners[1]!, 2),
    );
    await make({ notifier: { notify: async (n) => void sent.push(n) }, pageSize: 10 }).pollOnce();
    expect(sent.map((n) => n.kind)).toEqual(["proposal_created", "proposal_approved"]);
  });

  it("keeps indexing when a notifier fails", async () => {
    source.push(TREASURY, events.initialized(), events.proposed(0), events.proposed(1));
    const notifier = { notify: vi.fn(async () => Promise.reject(new Error("slack down"))) };
    expect(await make({ notifier, pageSize: 10 }).pollOnce()).toBe(3);
    expect(notifier.notify).toHaveBeenCalledTimes(2);
    expect(db.listProposals(TREASURY).total).toBe(2);
  });

  it("run stops when aborted", async () => {
    const controller = new AbortController();
    const indexer = make({ pollIntervalMs: 10 });
    const running = indexer.run(controller.signal);
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    await running;
    expect(source.requests.length).toBeGreaterThan(0);
  });
});

describe("WebhookNotifier", () => {
  const notification = { kind: "proposal_created", treasuryId: TREASURY, threshold: 2, pendingApprovers: [] } as unknown as Notification;
  const ok = () => new Response("ok", { status: 200 });

  it("posts JSON and signs it", async () => {
    const fetchMock = vi.fn(async () => ok());
    await new WebhookNotifier("https://hooks.example/x", { secret: "s3cret", fetch: fetchMock as never }).notify(notification);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example/x");
    const body = String(init.body);
    expect(JSON.parse(body).kind).toBe("proposal_created");
    const expected = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
    expect((init.headers as Record<string, string>)["x-treasury-signature"]).toBe(expected);
  });

  it("sends no signature without a secret", async () => {
    const fetchMock = vi.fn(async () => ok());
    await new WebhookNotifier("https://h.example", { fetch: fetchMock as never }).notify(notification);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["x-treasury-signature"]).toBeUndefined();
  });

  it("retries server errors then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("no", { status: 503 }))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(ok());
    await new WebhookNotifier("https://h.example", { fetch: fetchMock as never, retryDelayMs: 1 }).notify(notification);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after the attempts and throws", async () => {
    const fetchMock = vi.fn(async () => new Response("no", { status: 500 }));
    await expect(
      new WebhookNotifier("https://h.example", { fetch: fetchMock as never, retryDelayMs: 1, attempts: 2 }).notify(notification),
    ).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a client error", async () => {
    const fetchMock = vi.fn(async () => new Response("bad", { status: 404 }));
    await expect(
      new WebhookNotifier("https://h.example", { fetch: fetchMock as never, retryDelayMs: 1 }).notify(notification),
    ).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("HTTP API", () => {
  let db: Db;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    db = new Db(":memory:");
    const source = new FakeSource();
    source.push(
      TREASURY,
      events.initialized(),
      events.proposed(0),
      events.proposed(1, owners[1], 20, 1000),
      events.approved(0, owners[1]!, 2),
      events.executed(0),
      events.limitSet(),
    );
    await new Indexer({ db, source, treasuryIds: [TREASURY], logger: silent, pageSize: 10 }).pollOnce();
    server = createApi(db, [TREASURY]);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  const get = async (path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  it("health", async () => {
    expect(await get("/health")).toEqual({ status: 200, body: { status: "ok" } });
  });

  it("lists proposals newest first", async () => {
    const { status, body } = await get(`/treasuries/${TREASURY}/proposals`);
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.proposals.map((p: { id: number }) => p.id)).toEqual([1, 0]);
    expect(body.proposals[1]).toMatchObject({ status: "executed", amount: "500", to: recipient, asset: ASSET });
  });

  it("filters by status and pages", async () => {
    const expired = await get(`/treasuries/${TREASURY}/proposals?status=expired`);
    expect(expired.body.proposals.map((p: { id: number }) => p.id)).toEqual([1]);
    const executed = await get(`/treasuries/${TREASURY}/proposals?status=executed&limit=1`);
    expect(executed.body.proposals).toHaveLength(1);
    const page = await get(`/treasuries/${TREASURY}/proposals?limit=1&offset=1`);
    expect(page.body.proposals[0].id).toBe(0);
  });

  it("returns one proposal or 404", async () => {
    expect((await get(`/treasuries/${TREASURY}/proposals/0`)).body.id).toBe(0);
    expect((await get(`/treasuries/${TREASURY}/proposals/42`)).status).toBe(404);
    expect((await get(`/treasuries/${TREASURY}/proposals/abc`)).status).toBe(400);
  });

  it("returns the audit log, newest first", async () => {
    const { body } = await get(`/treasuries/${TREASURY}/audit-log`);
    expect(body.total).toBe(6);
    expect(body.entries.map((e: { type: string }) => e.type)).toEqual([
      "limit_set",
      "executed",
      "approved",
      "proposed",
      "proposed",
      "initialized",
    ]);
  });

  it("rejects bad input", async () => {
    expect((await get(`/treasuries/${TREASURY}/proposals?status=nope`)).status).toBe(400);
    expect((await get(`/treasuries/${TREASURY}/proposals?limit=0`)).status).toBe(400);
    expect((await get(`/treasuries/${TREASURY}/proposals?limit=1000`)).status).toBe(400);
    expect((await get(`/treasuries/${TREASURY}/proposals?offset=-1`)).status).toBe(400);
    expect((await get(`/treasuries/not-an-id/proposals`)).status).toBe(400);
  });

  it("404s for an untracked treasury and unknown routes", async () => {
    expect((await get(`/treasuries/${OTHER_TREASURY}/proposals`)).status).toBe(404);
    expect((await get(`/nope`)).status).toBe(404);
  });

  it("sends no CORS header unless configured, and the configured origin when it is", async () => {
    expect((await fetch(`${base}/health`)).headers.get("access-control-allow-origin")).toBeNull();
    const withCors = createApi(db, [TREASURY], { corsOrigin: "http://localhost:3000" });
    await new Promise<void>((resolve) => withCors.listen(0, resolve));
    const port = (withCors.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    await new Promise((resolve) => withCors.close(resolve));
  });

  it("only allows GET", async () => {
    const res = await fetch(`${base}/health`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("loadConfig", () => {
  const base = { RPC_URL: "https://rpc.example", TREASURY_IDS: TREASURY };

  it("reads settings and applies defaults", () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({ port: 3000, pollIntervalMs: 5000, dbPath: "treasury.db", treasuryIds: [TREASURY] });
    expect(config.networkPassphrase).toContain("Test SDF");
    expect(config.webhookUrl).toBeUndefined();
  });

  it("parses lists and numbers, and removes duplicates", () => {
    const config = loadConfig({
      ...base,
      TREASURY_IDS: ` ${TREASURY}, ${OTHER_TREASURY},${TREASURY}`,
      PORT: "8080",
      START_LEDGER: "123",
      WEBHOOK_URL: "https://hooks.example",
    });
    expect(config.treasuryIds).toEqual([TREASURY, OTHER_TREASURY]);
    expect(config.port).toBe(8080);
    expect(config.startLedger).toBe(123);
    expect(config.webhookUrl).toBe("https://hooks.example");
  });

  it.each([
    [{ TREASURY_IDS: TREASURY }],
    [{ RPC_URL: "https://rpc.example" }],
    [{ ...base, RPC_URL: "nope" }],
    [{ ...base, TREASURY_IDS: "GABC" }],
    [{ ...base, PORT: "abc" }],
    [{ ...base, POLL_INTERVAL_MS: "5" }],
    [{ ...base, WEBHOOK_URL: "not a url" }],
  ])("rejects bad settings %#", (env) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });
});
