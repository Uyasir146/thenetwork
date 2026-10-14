// Real local HTTP provider transport and Postgres OTP lifecycle. No external provider is called.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { BlooioClient } from "@thenetwork/blooio";
import { APPS } from "../src/apps.ts";
import { createPublicApi } from "../src/api.ts";
import { bootConfigProblems } from "../src/env.ts";
import { BlooioOtpProvider, OtpService, otpProviderFromEnv, type OtpProvider } from "../src/otp.ts";
import { PgPeopleStore } from "../src/pg-store.ts";
import { keyedHash } from "../src/phone.ts";
import { loadConfig } from "../../../deploy/backend/backend.ts";
import { CostLedger, PgCostSink, costRatesFromEnv, type CostRow } from "../../network/service/cost.ts";
import { dropDb, migratedDb, pgAvailable } from "./pg.ts";

if (!pgAvailable && process.env.REQUIRE_PG === "1") throw new Error("Postgres required");
const KEY = "owned-otp-integration-key-0123456789";
const ENV = { OTP_PROVIDER: "blooio", BLOOIO_API_KEY: "synthetic-key", BLOOIO_FROM: "+12125550100" };
let url: string, sql: SQL, store: PgPeopleStore, server: ReturnType<typeof Bun.serve>;
let mode = "queued", sequence = 0, now = Date.UTC(2026, 9, 13), phoneSequence = 10;
const requests: Array<{ code: string; key: string; from: string; to: string }> = [];
const logs: string[] = [];
const statusRequests: string[] = [];
const phone = () => `+121255501${++phoneSequence}`;
const provider = () => new BlooioOtpProvider(ENV, { baseUrl: `http://127.0.0.1:${server.port}/v4`, timeoutMs: 50 });
const service = (p: OtpProvider) => new OtpService(store, p, { hashKey: KEY, now: () => now, log: line => logs.push(line) });

describe.skipIf(!pgAvailable)("Blooio OTP via local HTTP and Postgres", () => {
  beforeAll(async () => {
    url = await migratedDb("blooio_otp"); sql = new SQL({ url }); store = new PgPeopleStore(sql);
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "GET") {
        expect(path).toMatch(/^\/v4\/chats\/chat_message_\d+\/messages\/message_\d+\/status$/);
        expect(req.headers.get("authorization")).toBe("Bearer synthetic-key");
        statusRequests.push(path);
        return Response.json({ status: "delivered" });
      }
      expect(path).toBe("/v4/messages");
      expect(req.headers.get("authorization")).toBe("Bearer synthetic-key");
      const body = await req.json() as { text: string; from: string; to: string };
      const code = /\b\d{6}\b/.exec(body.text)![0];
      requests.push({ code, key: req.headers.get("idempotency-key")!, from: body.from, to: body.to });
      if (mode === "timeout") { await Bun.sleep(120); return Response.json({ id: "late", status: "queued" }); }
      if (mode === "reject") return Response.json({ error: { message: `echoed code ${code} phone ${body.to} key synthetic-key`, code: "denied" } }, { status: 403 });
      if (mode === "missing-id") return Response.json({ status: "queued" });
      const id = `message_${++sequence}`;
      return Response.json({ id, ...(mode === "no-chat" ? {} : { chat_id: `chat_${id}` }), ...(mode === "missing-status" ? {} : { status: mode === "no-chat" ? "queued" : mode }) }, { status: 201 });
    } });
  });
  afterAll(async () => { server?.stop(true); await sql?.close(); if (url) await dropDb(url); });

  test("explicit provider configuration preserves Twilio and rejects missing or ambiguous Blooio authority", () => {
    expect(() => otpProviderFromEnv({ PLATFORM_ENV: "dev", OTP_PROVIDER: "unexpected" })).toThrow("Unknown OTP_PROVIDER");
    expect(() => new BlooioOtpProvider({ ...ENV, OTP_PROVIDER: "twilio" })).toThrow("OTP_PROVIDER=blooio");
    for (const env of [{ ...ENV, BLOOIO_API_KEY: "" }, { ...ENV, BLOOIO_FROM: "" }, { ...ENV, BLOOIO_FROM_NUMBER: "+12125550101" }]) expect(() => new BlooioOtpProvider(env)).toThrow();
    const base = { PLATFORM_ENV: "staging", DATABASE_URL: "postgres://svc@db.invalid/test", MIGRATION_DATABASE_URL: "postgres://owner@db.invalid/test", PLATFORM_HASH_KEY: KEY, PLATFORM_SESSION_SECRET: KEY, PLATFORM_PROXY_SECRET: KEY, LEAK_LABEL_KEY: KEY, TURNSTILE_SECRET_KEY: "synthetic" };
    expect(bootConfigProblems({ ...base, ...ENV })).toEqual([]);
    expect(loadConfig({ ...base, ...ENV }).env).toBe("staging");
    expect(() => loadConfig({ ...base, ...ENV, BLOOIO_FROM: "" })).toThrow("BLOOIO_FROM");
    const twilio = { OTP_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "synthetic", TWILIO_AUTH_TOKEN: "synthetic", TWILIO_VERIFY_SERVICE_SID: "synthetic" };
    expect(bootConfigProblems({ ...base, ...twilio })).toEqual([]);
    expect(otpProviderFromEnv(twilio).name).toBe("twilio_verify");
  });

  test("queued code is hashed, app-bound, one-use and never placed in ordinary API responses or logs", async () => {
    mode = "queued";
    const p = phone();
    const api = createPublicApi({ store, otp: provider(), env: { PLATFORM_ENV: "dev" }, hashKey: KEY, now: () => now, minStartMs: 0, minVerifyMs: 0, log: l => logs.push(l) });
    const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async req => (await api.fetch(new Request(`http://localhost:5103${new URL(req.url).pathname}`, req))) ?? new Response(null, { status: 404 }) });
    try {
      const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${http.port}${path}`, { method: "POST", headers: { "content-type": "application/json", host: "localhost:5103" }, body: JSON.stringify(body) });
      const start = await post("/api/auth/otp/start", { phone: p });
      expect(start.status).toBe(200);
      const sent = requests.at(-1)!;
      expect(sent.code).toMatch(/^\d{6}$/); expect(sent.from).toBe(ENV.BLOOIO_FROM); expect(sent.to).toBe(p); expect(sent.key).toMatch(/^otp:/);
      expect(await start.text()).not.toContain(sent.code);
      const c = await store.latestChallenge("peon", p);
      expect(c).toMatchObject({ provider: "blooio", attempts: 0, expiresAt: now + 600000 });
      expect(c!.codeHash).toBe(keyedHash(KEY, `peon:${p}:${sent.code}`));
      expect(JSON.stringify(c)).not.toContain(sent.code);
      expect(await service(provider()).verify("friends", p, sent.code)).toBe(false);
      const first = await post("/api/auth/otp/verify", { phone: p, code: sent.code });
      expect(first.status).toBe(200); expect(first.headers.get("set-cookie")).toContain("sid_peon=");
      expect((await post("/api/auth/otp/verify", { phone: p, code: sent.code })).status).toBe(400);
      expect(logs.join("\n")).not.toContain(sent.code);
    } finally { http.stop(true); }
  });

  test("private receipt survives Postgres and enables a status-only lookup without exposing it in auth responses", async () => {
    mode = "queued";
    const p = phone();
    const api = createPublicApi({ store, otp: provider(), env: { PLATFORM_ENV: "dev" }, hashKey: KEY, now: () => now, minStartMs: 0, minVerifyMs: 0, log: l => logs.push(l) });
    const response = await api.fetch(new Request("http://localhost:5103/api/auth/otp/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: p }) }));
    expect(response!.status).toBe(200);
    const c = await new PgPeopleStore(sql).latestChallenge("peon", p);
    expect(c).toHaveProperty("providerChatId", `chat_${c!.providerRef}`);
    const [row] = await sql`select provider_ref, provider_chat_id from platform.otp_challenges where id = ${c!.id}`;
    const client = new BlooioClient({ apiKey: ENV.BLOOIO_API_KEY, baseUrl: `http://127.0.0.1:${server.port}/v4` });
    const count = requests.length;
    expect(await client.getMessageStatus(row!.provider_chat_id, row!.provider_ref)).toEqual({ status: "delivered" });
    expect(statusRequests.at(-1)).toBe(`/v4/chats/chat_${c!.providerRef}/messages/${c!.providerRef}/status`);
    expect(requests.length).toBe(count);
    const text = await response!.text();
    for (const privateValue of [c!.providerRef!, `chat_${c!.providerRef}`, requests.at(-1)!.code, ENV.BLOOIO_API_KEY]) {
      expect(text).not.toContain(privateValue);
      expect(logs.join("\n")).not.toContain(privateValue);
    }
    mode = "no-chat";
    const legacy = phone();
    await service(provider()).start(APPS.peon, legacy, legacy);
    expect(await store.latestChallenge("peon", legacy)).toHaveProperty("providerChatId", null);
    expect(await service(provider()).verify("peon", legacy, requests.at(-1)!.code, legacy)).toBe(true);
  });

  test("expiry, wrong attempts, rate limits and provider switches cannot consume another provider's challenge", async () => {
    mode = "queued"; const otp = service(provider());
    let p = phone(); await otp.start(APPS.peon, p, p); let code = requests.at(-1)!.code;
    const other = service({ name: "twilio_verify", send: async () => ({}), check: async () => true });
    expect(await other.verify("peon", p, code)).toBe(false);
    expect((await store.latestChallenge("peon", p))!.attempts).toBe(0);
    expect(await otp.verify("peon", p, code)).toBe(true);
    p = phone(); await otp.start(APPS.peon, p, p); code = requests.at(-1)!.code;
    const prior = requests.length;
    expect((await otp.start(APPS.peon, p, p)).ok).toBe(false); expect(requests.length).toBe(prior);
    now += 600001; expect(await otp.verify("peon", p, code)).toBe(false);
    p = phone(); await otp.start(APPS.peon, p, p); code = requests.at(-1)!.code;
    const wrong = code === "000000" ? "999999" : "000000";
    for (let i = 0; i < 5; i++) expect(await otp.verify("peon", p, wrong, p)).toBe(false);
    expect(await otp.verify("peon", p, code, p)).toBe(false);
    p = phone(); await store.putChallenge({ app: "peon", e164: p, provider: "twilio_verify", providerRef: "synthetic-verification", codeHash: null, attempts: 0, createdAt: now, expiresAt: now + 600000, consumedAt: null });
    expect(await otp.verify("peon", p, "123456", p)).toBe(false); expect((await store.latestChallenge("peon", p))!.attempts).toBe(0);
    expect(await other.verify("peon", p, "123456", p)).toBe(true);
  });

  test("rejected, malformed and uncertain sends never create a usable challenge or try another provider", async () => {
    for (mode of ["reject", "failed", "missing-id", "missing-status", "unknown", "timeout"]) {
      const p = phone(), count = requests.length, logCount = logs.length;
      expect(await service(provider()).start(APPS.peon, p, p)).toEqual({ ok: true });
      expect(requests.length).toBe(count + 1);
      expect(await store.latestChallenge("peon", p)).toBeUndefined();
      const diagnostic = mode === "reject" ? "failure=blocked, http=403" : mode === "failed" ? "failure=unknown, http=none" : mode === "timeout" ? "failure=retryable, http=none" : mode === "missing-id" ? "failure=retryable, http=200" : "failure=retryable, http=201";
      expect(logs.slice(logCount)).toEqual([`[otp] send failed for peon: Blooio OTP send was not confirmed; no fallback was attempted (${diagnostic})`]);
      for (const secret of [requests.at(-1)!.code, p, "synthetic-key"]) expect(logs.join("\n")).not.toContain(secret);
    }
  });

  test("accepted Blooio OTP has one text-cost estimate and failures add no acceptance cost", async () => {
    const writes: Promise<void>[] = [];
    const sink = new PgCostSink(sql);
    const ledger = new CostLedger({ clock: { now: () => now }, rates: costRatesFromEnv({ COST_SMS_USD: "0.009" }),
      sink: { write(rows: CostRow[]) { const write = sink.write(rows); writes.push(write); return write; }, totals: day => sink.totals(day) } });
    mode = "queued";
    await service(ledger.meterOtp(provider())).start(APPS.peon, phone(), "cost-accepted");
    mode = "reject";
    await service(ledger.meterOtp(provider())).start(APPS.peon, phone(), "cost-rejected");
    await Promise.all(writes);
    const rows = await sql`select app_id, kind, provider, cost_usd::float8 as cost, estimated, detail from network.cost_ledger`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ app_id: "peon", kind: "otp_verify", provider: "blooio", cost: 0.009, estimated: true, detail: { pricing: "sms_estimate", acceptance: "provider" } });
    for (const sent of requests) expect(JSON.stringify(rows)).not.toContain(sent.code);
    expect(JSON.stringify(rows)).not.toContain("synthetic-key");
    expect(JSON.stringify(rows)).not.toContain("+1212");
  });
});
