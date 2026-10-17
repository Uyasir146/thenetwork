import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { applySchema, devPgUp, DEV_PG_PORT } from "../../observatory/db/dev-pg.ts";
import { loadSnapshot } from "../service/snapshot.ts";
import { ProfileSuggestions, type SuggestionOwner, type SourceSuggestion } from "../service/profile-suggestions.ts";
import { PgPeopleStore } from "../../platform/src/pg-store.ts";
import { SimClock } from "@thenetwork/core";
import { NetworkService } from "../service/service.ts";
import { renderSuggestionReview, reviewSuggestionMessage } from "../service/profile-suggestion-review.ts";
import { svcSign } from "../../core/src/svc/svc-auth.ts";
import { SUGGESTION_PATH, type SuggestionIdentityResolver } from "../service/profile-suggestion-endpoint.ts";

const now = Date.UTC(2026, 9, 17, 12);
const db = `profile_suggestions_${process.pid}`;
const base = `postgres://${process.env.USER ?? "postgres"}@localhost:${DEV_PG_PORT}`;
let sql: SQL;
let active = true;
let owner: SuggestionOwner;
let store: ProfileSuggestions;
const candidate = (): SourceSuggestion => ({ connectionId: "owned-google-connection", source: "gmail", observedAt: now - 1000,
  kind: "interest", value: "I enjoy climbing", tags: ["climbing"], confidence: 0.7, scope: "agent_private" });
const input = (suggestions = [candidate()], retainOnDisconnect = false) => ({ windowStart: now - 60_000, windowEnd: now,
  timezone: "America/Los_Angeles", allowedKinds: ["interest" as const], expiresAt: now + 60_000, retainOnDisconnect, suggestions });
const facets = async () => (await loadSnapshot(sql, now, { app: "ntwrk" })).facets;

beforeAll(async () => {
  await devPgUp();
  const admin = new SQL(`${base}/postgres`);
  await admin.unsafe(`create database ${db}`);
  await admin.close();
  sql = new SQL(`${base}/${db}`);
});
beforeEach(async () => {
  await applySchema(`${base}/${db}`, { reset: true });
  owner = { personId: randomUUID(), app: "ntwrk", chatId: "own-chat", userId: "own-user", organizationId: "own-org" };
  await sql`insert into platform.people(id,lowest_age,phone_hash) values(${owner.personId},30,'fixture-phone-hash')`;
  await sql`insert into platform.memberships(person_id,app_id,member_id,state,first_name,profile) values(${owner.personId},'ntwrk','owned-member','active','Alex','{}')`;
  await sql`insert into network.members(id,app_id,person_id,name,age,home_city,account_status) values('owned-member','ntwrk',${owner.personId},'Alex',30,'nyc','active')`;
  active = true;
  store = new ProfileSuggestions(sql, async (who, consent) => active && who.userId === owner.userId && who.organizationId === owner.organizationId && consent.connectionId === "owned-google-connection" && consent.allowedKinds.every(k => k === "interest"));
});
afterAll(async () => {
  await sql.close();
  const admin = new SQL(`${base}/postgres`);
  await admin.unsafe(`drop database ${db}`);
  await admin.close();
});

test("pending data never enters the canonical snapshot; exact review promotes source and observation time", async () => {
  const b = (await store.propose(owner, input(), now))!;
  expect(b.retainOnDisconnect).toBe(false);
  expect(await facets()).toHaveLength(0);
  expect(await store.decide(owner, { batchId: b.id, revision: b.revision, decisions: [{ suggestionId: b.suggestions[0]!.id, action: "accept" }] }, now)).toMatchObject({ kind: "saved" });
  expect(await facets()).toEqual([expect.objectContaining({ value: "I enjoy climbing", source: "gmail", provenance: "inferred", inferred: true,
    confirmedByMember: true, observedAt: now - 1000, scope: "agent_private" })]);
  expect((await sql`select value,tags,status from platform.profile_suggestions`)[0]).toMatchObject({ value: null, tags: [], status: "accepted" });
  expect(await store.decide(owner, { batchId: b.id, revision: b.revision, decisions: [{ suggestionId: b.suggestions[0]!.id, action: "accept" }] }, now)).toEqual({ kind: "denied" });
  expect(await facets()).toHaveLength(1);
});

test("wrong owner, organization, chat, app and stale revisions do not promote data", async () => {
  const b = (await store.propose(owner, input(), now))!;
  const decision = { batchId: b.id, revision: b.revision, decisions: [{ suggestionId: b.suggestions[0]!.id, action: "accept" as const }] };
  for (const wrong of [{ userId: "other" }, { organizationId: "other" }, { chatId: "other" }, { app: "friends" as const }, { personId: randomUUID() }]) {
    expect(await store.getPendingBatch({ ...owner, ...wrong }, b.id, now)).toBeNull();
    expect(await store.decide({ ...owner, ...wrong }, decision, now)).toEqual({ kind: "denied" });
  }
  expect(await store.decide(owner, { ...decision, revision: 99 }, now)).toEqual({ kind: "denied" });
  expect(await facets()).toHaveLength(0);
});

test("edit and scope changes require a new preview and later exact approval; mixed invalid decisions are atomic", async () => {
  const b = (await store.propose(owner, input([candidate(), { ...candidate(), value: "I enjoy hiking", tags: ["hiking"] }]), now))!;
  const id = b.suggestions[0]!.id;
  const changed = await store.decide(owner, { batchId: b.id, revision: b.revision,
    decisions: [{ suggestionId: id, action: "accept", editedValue: "I enjoy outdoor climbing", scope: "matchable" }] }, now);
  expect(changed.kind).toBe("preview");
  expect(await facets()).toHaveLength(0);
  if (changed.kind !== "preview") throw new Error("preview missing");
  expect(changed.batch.revision).toBe(b.revision + 1);
  expect(await store.decide(owner, { batchId: b.id, revision: changed.batch.revision, decisions: [
    { suggestionId: id, action: "accept" }, { suggestionId: randomUUID(), action: "reject" }] }, now)).toEqual({ kind: "denied" });
  expect(await facets()).toHaveLength(0);
  expect(await store.decide(owner, { batchId: b.id, revision: changed.batch.revision, decisions: [
    { suggestionId: id, action: "accept" }, { suggestionId: b.suggestions[1]!.id, action: "reject" }] }, now)).toMatchObject({ kind: "saved" });
  expect(await facets()).toEqual([expect.objectContaining({ value: "I enjoy outdoor climbing", scope: "matchable", tags: [] })]);
});

test("rejection and expiry wipe pending content without canonical facts", async () => {
  const b = (await store.propose(owner, input(), now))!;
  await store.decide(owner, { batchId: b.id, revision: b.revision, decisions: [{ suggestionId: b.suggestions[0]!.id, action: "reject" }] }, now);
  const e = (await store.propose(owner, input(), now))!;
  expect(await store.getPendingBatch(owner, e.id, e.expiresAt)).toBeNull();
  expect(await store.decide(owner, { batchId: e.id, revision: e.revision, decisions: [{ suggestionId: e.suggestions[0]!.id, action: "accept" }] }, e.expiresAt)).toEqual({ kind: "denied" });
  expect(await facets()).toHaveLength(0);
  expect((await sql`select value from platform.profile_suggestions`).every((r: any) => r.value === null)).toBe(true);
});

test("revoked source cannot propose or accept; disconnect respects the explicit retained-fact choice", async () => {
  const b = (await store.propose(owner, input(), now))!;
  active = false;
  expect(await store.propose(owner, input(), now)).toBeNull();
  expect(await store.decide(owner, { batchId: b.id, revision: b.revision, decisions: [{ suggestionId: b.suggestions[0]!.id, action: "accept" }] }, now)).toEqual({ kind: "denied" });
  await store.disconnect(owner, "owned-google-connection");
  expect((await store.getPendingBatch(owner, b.id, now))?.suggestions).toHaveLength(0);
  active = true;
  for (const retain of [false, true]) {
    const x = (await store.propose(owner, input([candidate()], retain), now))!;
    await store.decide(owner, { batchId: x.id, revision: x.revision, decisions: [{ suggestionId: x.suggestions[0]!.id, action: "accept" }] }, now);
  }
  active = false;
  await store.disconnect(owner, "owned-google-connection");
  expect(await facets()).toHaveLength(1);
});

test("deleting a batch and leaving the app remove only linked derived facts", async () => {
  const b = (await store.propose(owner, input(), now))!;
  await store.decide(owner, { batchId: b.id, revision: b.revision, decisions: [{ suggestionId: b.suggestions[0]!.id, action: "accept" }] }, now);
  await sql`insert into network.facets(id,app_id,member_id,kind,value,privacy_scope,provenance) values('unrelated','ntwrk','owned-member','interest','hiking','matchable','said')`;
  expect(await store.deleteBatch(owner, b.id)).toBe(true);
  expect((await facets()).map(f => f.id)).toEqual(["unrelated"]);
  const c = (await store.propose(owner, input(), now))!;
  await store.decide(owner, { batchId: c.id, revision: c.revision, decisions: [{ suggestionId: c.suggestions[0]!.id, action: "accept" }] }, now);
  await new PgPeopleStore(sql).forgetMembership(owner.personId, owner.app, now);
  expect(await sql`select 1 from platform.profile_suggestion_batches`).toHaveLength(0);
  expect((await sql`select id from network.facets order by id`).map((r: any) => r.id)).toEqual(["unrelated"]);
});

test("no default data window, retention choice, contact details or sensitive inference is accepted", async () => {
  for (const value of ["email alex@example.test", "phone +12125550100", "health cancer", "https://example.test/private"]) {
    expect(await store.propose(owner, input([{ ...candidate(), value }]), now)).toBeNull();
  }
  expect(await store.propose(owner, { ...input(), windowStart: -Infinity }, now)).toBeNull();
  expect(await store.propose(owner, { ...input(), retainOnDisconnect: undefined as never }, now)).toBeNull();
  expect(await store.propose(owner, input([{ ...candidate(), tags: ["health:cancer"] }]), now)).toBeNull();
  expect(await sql`select 1 from platform.profile_suggestion_batches`).toHaveLength(0);
});

test("the authorizer receives the exact chosen window, fields and retention; future calendar windows are not observation times", async () => {
  const seen: unknown[] = [];
  const restricted = new ProfileSuggestions(sql, async (_owner, consent) => { seen.push(consent); return consent.windowEnd === now + 86_400_000 && !consent.retainOnDisconnect; });
  expect(await restricted.propose(owner, input(), now)).toBeNull();
  const b = await restricted.propose(owner, { ...input(), windowStart: now, windowEnd: now + 86_400_000 }, now);
  expect(b?.windowEnd).toBe(now + 86_400_000);
  expect(seen[1]).toMatchObject({ windowStart: now, windowEnd: now + 86_400_000, allowedKinds: ["interest"], retainOnDisconnect: false });
});

test("simultaneous approvals create one fact; a database failure rolls promotion back", async () => {
  const b = (await store.propose(owner, input(), now))!;
  const decision = { batchId: b.id, revision: b.revision, decisions: [{ suggestionId: b.suggestions[0]!.id, action: "accept" as const }] };
  const results = await Promise.all([store.decide(owner, decision, now), store.decide(owner, decision, now)]);
  expect(results.map(r => r.kind).sort()).toEqual(["denied", "saved"]);
  expect(await facets()).toHaveLength(1);
  const c = (await store.propose(owner, input(), now))!;
  await sql.unsafe(`create function platform.fail_review_fixture() returns trigger language plpgsql as $$ begin if new.status='accepted' then raise exception 'fixture failure'; end if; return new; end $$`);
  await sql.unsafe(`create trigger fail_review_fixture before update on platform.profile_suggestions for each row execute function platform.fail_review_fixture()`);
  await expect(store.decide(owner, { batchId: c.id, revision: c.revision, decisions: [{ suggestionId: c.suggestions[0]!.id, action: "accept" }] }, now)).rejects.toThrow("fixture failure");
  expect(await facets()).toHaveLength(1);
  expect((await store.getPendingBatch(owner, c.id, now))?.revision).toBe(c.revision);
});

test("row-level app isolation and full account deletion cover private review records", async () => {
  const b = (await store.propose(owner, input(), now))!;
  await store.decide(owner, { batchId: b.id, revision: b.revision, decisions: [{ suggestionId: b.suggestions[0]!.id, action: "accept" }] }, now);
  await sql.begin(async tx => {
    await tx.unsafe("set local role network_service");
    await tx`select set_config('app.app_id','friends',true)`;
    expect(await tx`select id from platform.profile_suggestion_batches`).toHaveLength(0);
    expect(await tx`select id from platform.profile_suggestions`).toHaveLength(0);
  });
  await new PgPeopleStore(sql).deleteAll(owner.personId, "+12125550100", "fixture-phone-hash", now);
  expect(await sql`select id from platform.profile_suggestion_batches`).toHaveLength(0);
  expect(await sql`select id from platform.profile_suggestions`).toHaveLength(0);
  expect(await facets()).toHaveLength(0);
  expect(await store.decide(owner, { batchId: b.id, revision: b.revision, decisions: [{ suggestionId: b.suggestions[0]!.id, action: "accept" }] }, now)).toEqual({ kind: "denied" });
});

test("source disconnect clears every owned chat even after STOP without deleting retained facts", async () => {
  const otherChat = { ...owner, chatId: "another-chat" };
  const b = (await store.propose(otherChat, input(), now))!;
  await store.decide(otherChat, { batchId: b.id, revision: b.revision, decisions: [{ suggestionId: b.suggestions[0]!.id, action: "accept" }] }, now);
  await store.propose(otherChat, input(), now);
  await sql`update network.members set opted_out=true where id='owned-member'`;
  await sql`update platform.memberships set state='paused' where person_id=${owner.personId}`;
  await store.disconnect(owner, "owned-google-connection");
  expect(await facets()).toHaveLength(0);
  expect((await sql`select value,status from platform.profile_suggestions`).every((r: any) => r.value === null && r.status === 'withdrawn')).toBe(true);
});

test("expired decisions and periodic cleanup erase pending values without waiting for another preview", async () => {
  const a = (await store.propose(owner, input(), now))!;
  await store.propose(owner, input(), now);
  expect(await store.decide(owner, { batchId: a.id, revision: a.revision, decisions: [{ suggestionId: a.suggestions[0]!.id, action: "accept" }] }, a.expiresAt)).toEqual({ kind: "denied" });
  expect((await sql`select value from platform.profile_suggestions where batch_id=${a.id}`)[0].value).toBeNull();
  await store.expirePending(owner.app, a.expiresAt);
  expect((await sql`select value,status from platform.profile_suggestions`).every((r: any) => r.value === null && r.status === 'expired')).toBe(true);
  expect(await facets()).toHaveLength(0);
});

test("iMessage review adapter uses the actual store and never accepts an edit or scope change implicitly", async () => {
  const b = (await store.propose(owner, input(), now))!;
  expect(renderSuggestionReview(b, owner, now)).toContain("remove these accepted facts");
  expect(await reviewSuggestionMessage(store, { ...owner, userId: "other" }, b.id, `accept ${b.id}.${b.revision} 1 private`, now)).toBeNull();
  expect(await reviewSuggestionMessage(store, owner, b.id, "yes", now)).toBeNull();
  const edited = await reviewSuggestionMessage(store, owner, b.id, `edit ${b.id}.${b.revision} 1: I enjoy indoor climbing`, now);
  expect(edited?.kind).toBe("preview");
  expect(await facets()).toHaveLength(0);
  if (edited?.kind !== "preview") throw new Error("edit preview missing");
  expect(await reviewSuggestionMessage(store, owner, b.id, `accept ${b.id}.${b.revision} 1 private`, now)).toBeNull();
  const scoped = await reviewSuggestionMessage(store, owner, b.id, `accept ${b.id}.${edited.batch.revision} 1 matching`, now);
  expect(scoped?.kind).toBe("preview");
  expect(await facets()).toHaveLength(0);
  if (scoped?.kind !== "preview") throw new Error("scope preview missing");
  expect(await reviewSuggestionMessage(store, owner, b.id, `accept ${b.id}.${scoped.batch.revision} 1 matching`, now)).toMatchObject({ kind: "saved" });
  expect(await facets()).toEqual([expect.objectContaining({ value: "I enjoy indoor climbing", source: "gmail", inferred: true, confirmedByMember: true,
    observedAt: now - 1000, scope: "matchable", tags: [] })]);
});

test("the normal service purge expires prior suggestions even after source authorization is disabled", async () => {
  await store.propose(owner, input(), now);
  const service = new NetworkService({ url: `${base}/${db}`, clock: new SimClock(now + 60_000), env: { PLATFORM_ENV: "dev" },
    networks: [{ id: "ntwrk:nyc" }], log: () => {} });
  try {
    await service.purge();
    expect((await sql`select value,status from platform.profile_suggestions`)[0]).toMatchObject({ value: null, status: "expired" });
    expect(await facets()).toHaveLength(0);
  } finally { await service.close(); }
});

test("invalid clocks cannot bypass expiry or promote a fact", async () => {
  const b = (await store.propose(owner, input(), now))!;
  expect(await store.getPendingBatch(owner, b.id, NaN)).toBeNull();
  expect(await store.decide(owner, { batchId: b.id, revision: b.revision, decisions: [{ suggestionId: b.suggestions[0]!.id, action: "accept" }] }, NaN)).toEqual({ kind: "denied" });
  expect(await facets()).toHaveLength(0);
});

test("a canonical ban blocks promotion but permits deleting owned suggestions", async () => {
  const b = (await store.propose(owner, input(), now))!;
  await sql`insert into platform.bans(id,scope,person_id,reason,banned_by) values('fixture-ban','person',${owner.personId},'fixture','fixture')`;
  expect(await store.decide(owner, { batchId: b.id, revision: b.revision, decisions: [{ suggestionId: b.suggestions[0]!.id, action: "accept" }] }, now)).toEqual({ kind: "denied" });
  expect(await store.deleteBatch(owner, b.id)).toBe(true);
  expect(await store.propose(owner, input(), now)).toBeNull();
  expect(await facets()).toHaveLength(0);
});

const httpSecret = "local-suggestion-review-fixture-secret-only";
async function storedTurn(messageId: string, text: string, app = "ntwrk", memberId = "owned-member") {
  await sql`insert into platform.inbound(id,received_at,arrived_at,status,sender_hash,response)
    values(${`msg:blooio:${messageId}`},${new Date(now)},${new Date(now)},'done','fixture-phone-hash',${{ outcome: "open", app, memberId }}::jsonb)`;
  await sql`insert into network.messages(id,app_id,member_id,direction,body,ts)
    values(${`in:blooio:${messageId}`},${app},${memberId},'inbound',${text},${new Date(now)})`;
}
async function reviewHttp(resolveIdentity?: SuggestionIdentityResolver) {
  const clock = new SimClock(now);
  const service = new NetworkService({ url: `${base}/${db}`, clock, env: { PLATFORM_ENV: "dev", SERVICE_TURN_SECRET: httpSecret },
    networks: [{ id: "ntwrk:nyc" }], log: () => {}, profileSuggestionIdentity: resolveIdentity,
    profileSuggestionAuthorization: async () => active });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: service.fetch });
  return { clock, async stop() { server.stop(true); await service.close(); },
    async post(action: string, messageId: string, batchId: string, extra: Record<string, unknown> = {}, signedPath?: string) {
      const path = SUGGESTION_PATH + action;
      const body = JSON.stringify({ channel: "blooio", messageId, batchId, ...extra });
      const headers = await svcSign(httpSecret, { method: "POST", path: signedPath ?? path, id: `${messageId}:suggestions:${action}`, body, nowS: Math.floor(clock.now() / 1000) });
      const response = await fetch(new URL(path, server.url), { method: "POST", headers, body });
      expect(response.headers.get("cache-control")).toBe("no-store");
      return { status: response.status, body: await response.json() as any };
    } };
}
const boundIdentity: SuggestionIdentityResolver = async turn => turn.personId === owner.personId && turn.app === owner.app
  ? { userId: owner.userId, organizationId: owner.organizationId, chatId: owner.chatId } : null;

test("real HTTP review joins the signed stored turn, private preview, exact human decision and linked deletion", async () => {
  const b = (await store.propose(owner, input(), now))!;
  const http = await reviewHttp(boundIdentity);
  try {
    await storedTurn("preview", "show my suggestions");
    const preview = await http.post("preview", "preview", b.id);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ kind: "preview", batch: { id: b.id, chatId: owner.chatId } });
    expect(preview.body.reviewText).toContain("nothing saved yet");
    expect(await facets()).toHaveLength(0);
    const text = `accept ${b.id}.${b.revision} 1 private`;
    await storedTurn("accept", text);
    expect((await http.post("decide", "accept", b.id, { text })).body).toMatchObject({ kind: "saved", reviewText: "1 saved; 0 rejected." });
    expect(await facets()).toHaveLength(1);
    expect((await http.post("preview", "preview", b.id)).status).toBe(403);
    expect((await http.post("decide", "accept", b.id, { text })).status).toBe(403);
    expect(await facets()).toHaveLength(1);
    await storedTurn("delete", `delete ${b.id}`);
    expect((await http.post("delete", "delete", b.id, { text: `delete ${b.id}` })).body.kind).toBe("deleted");
    expect(await facets()).toHaveLength(0);
  } finally { await http.stop(); }
});

test("HTTP fails closed for unsigned identity fields, wrong Cloud ownership, forged human commands and missing binding", async () => {
  const b = (await store.propose(owner, input(), now))!;
  await storedTurn("human", "yes");
  let binding = { userId: owner.userId, organizationId: owner.organizationId, chatId: owner.chatId };
  const http = await reviewHttp(async () => binding);
  try {
    expect((await http.post("preview", "human", b.id, {}, SUGGESTION_PATH + "delete")).status).toBe(401);
    expect((await http.post("preview", "human", b.id, { personId: owner.personId })).status).toBe(400);
    for (const wrong of [{ userId: "other" }, { organizationId: "other" }, { chatId: "other" }]) {
      binding = { userId: owner.userId, organizationId: owner.organizationId, chatId: owner.chatId, ...wrong };
      expect((await http.post("preview", "human", b.id)).status).toBe(403);
    }
    binding = { userId: owner.userId, organizationId: owner.organizationId, chatId: owner.chatId };
    expect((await http.post("decide", "human", b.id, { text: `accept ${b.id}.${b.revision} 1 private` })).status).toBe(403);
    expect((await http.post("decide", "human", b.id, { text: "yes" })).status).toBe(403);
    expect((await http.post("preview", "missing", b.id)).status).toBe(403);
    expect(await facets()).toHaveLength(0);
  } finally { await http.stop(); }
  const disabled = await reviewHttp();
  try { expect((await disabled.post("preview", "human", b.id)).status).toBe(503); }
  finally { await disabled.stop(); }
});

test("HTTP edit, stale revision, source revoke and expiry cannot silently promote facts", async () => {
  const b = (await store.propose(owner, input(), now))!;
  const http = await reviewHttp(boundIdentity);
  try {
    const edit = `edit ${b.id}.${b.revision} 1: I enjoy hiking`;
    await storedTurn("edit", edit);
    const changed = await http.post("decide", "edit", b.id, { text: edit });
    expect(changed.body.kind).toBe("preview");
    expect(changed.body.batch.revision).toBe(2);
    expect(await facets()).toHaveLength(0);
    const stale = `accept ${b.id}.1 1 private`;
    await storedTurn("stale", stale);
    expect((await http.post("decide", "stale", b.id, { text: stale })).status).toBe(403);
    const text = `accept ${b.id}.2 1 private`;
    await storedTurn("accept", text);
    active = false;
    expect((await http.post("decide", "accept", b.id, { text })).status).toBe(403);
    active = true;
    http.clock.advance(60_000);
    expect((await http.post("decide", "accept", b.id, { text })).status).toBe(403);
    expect(await facets()).toHaveLength(0);
    expect((await sql`select value,status from platform.profile_suggestions`)[0]).toMatchObject({ value: null, status: "expired" });
  } finally { await http.stop(); }
});

test("HTTP identity revocation during the request and promotion faults roll back without saved success", async () => {
  const b = (await store.propose(owner, input(), now))!;
  const text = `accept ${b.id}.1 1 private`;
  await storedTurn("accept", text);
  let calls = 0;
  const revoked = await reviewHttp(async turn => ++calls === 1 ? boundIdentity(turn, sql) : null);
  try { expect((await revoked.post("decide", "accept", b.id, { text })).status).toBe(403); }
  finally { await revoked.stop(); }
  expect(await facets()).toHaveLength(0);
  await sql.unsafe(`create function network.reject_fixture_fact() returns trigger language plpgsql as $$ begin raise exception 'fixture fault'; end $$;
    create trigger reject_fixture_fact before insert on network.facets for each row execute function network.reject_fixture_fact()`);
  const http = await reviewHttp(boundIdentity);
  try {
    expect((await http.post("decide", "accept", b.id, { text })).body).toEqual({ error: "review_unavailable" });
    expect(await facets()).toHaveLength(0);
    expect((await sql`select value,status from platform.profile_suggestions`)[0]).toMatchObject({ value: "I enjoy climbing", status: "proposed" });
  } finally { await http.stop(); }
});
