import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { applySchema, devPgUp, DEV_PG_PORT } from "../../observatory/db/dev-pg.ts";
import { loadSnapshot } from "../service/snapshot.ts";
import { ProfileSuggestions, type SuggestionOwner, type SourceSuggestion, type SuggestionAuthorization } from "../service/profile-suggestions.ts";
import { PgPeopleStore } from "../../platform/src/pg-store.ts";
import { SimClock } from "@thenetwork/core";
import { NetworkService } from "../service/service.ts";
import { renderSuggestionReview, reviewSuggestionMessage } from "../service/profile-suggestion-review.ts";
import { svcSign, svcVerify } from "../../core/src/svc/svc-auth.ts";
import { SUGGESTION_PATH, type SuggestionIdentityResolver, type SuggestionTurnIdentity } from "../service/profile-suggestion-endpoint.ts";
import { cloudProfileReviewOwner } from "../service/cloud-profile-review-owner.ts";
import { PROFILE_REVIEW_OWNER_PATH, parseProfileReviewOwnerRequest } from "../../core/src/svc/profile-review-owner.ts";
import { PROFILE_REVIEW_SOURCE_PATH, parseProfileReviewSourceRequest, type ProfileReviewSourceRequest } from "../../core/src/svc/profile-review-source.ts";
import { profileReviewFactory, profileReviewFromEnv } from "../service/profile-review-factory.ts";
import type { NetworkRoutePolicy } from "../service/route-authority.ts";

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
async function reviewHttp(resolveIdentity?: SuggestionIdentityResolver, authorizeSource?: SuggestionAuthorization, routePolicy?: NetworkRoutePolicy,
  bootstrapEnv?: Record<string, string>) {
  const clock = new SimClock(now);
  const service = new NetworkService({ url: `${base}/${db}`, clock, env: { PLATFORM_ENV: routePolicy ? "staging" : "dev", SERVICE_TURN_SECRET: httpSecret,
    PLATFORM_HASH_KEY: "synthetic-review-factory-test-hash-key", ...(routePolicy ? { NETWORK_ROUTE_AUTHORITY_POLICY: JSON.stringify(routePolicy) } : {}), ...bootstrapEnv },
    networks: [{ id: "ntwrk:nyc" }], log: () => {}, profileSuggestionIdentity: resolveIdentity,
    profileSuggestionAuthorization: bootstrapEnv ? undefined : authorizeSource ?? (async () => active) });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: service.fetch });
  return { clock, service, async stop() { server.stop(true); await service.close(); },
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

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
async function ownerProofFixture() {
  const authority = { version: 1 as const, routeId: "fixture-review", generation: "generation-one", audience: "network-review-fixture", realmId: "fixture-realm" };
  const policy = { authority, admitUntil: now + 120_000, drainUntil: now + 180_000 };
  const identity = { userId: randomUUID(), organizationId: randomUUID(), chatId: `personal:${randomUUID()}` };
  const batchId = randomUUID();
  const text = `accept ${batchId}.1 1 private`;
  await storedTurn("owner-proof", text);
  await sql`update platform.inbound set request_hash=${digest("synthetic-signed-original-request")},network_authority=${authority}::jsonb where id='msg:blooio:owner-proof'`;
  const context: SuggestionTurnIdentity = { personId: owner.personId, memberId: "owned-member", app: "ntwrk", channel: "blooio", messageId: "owner-proof",
    action: "decide", batchId, commandSha256: digest(text), networkAuthority: authority };
  let calls = 0;
  let signed = true;
  let responseStatus = 200;
  let alter: (proof: Record<string, unknown>) => void = () => {};
  let sourceCalls = 0;
  let sourceAllowed: (request: ProfileReviewSourceRequest) => boolean = () => false;
  let alterSource: (proof: Record<string, unknown>) => void = () => {};
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    calls++;
    const path = new URL(req.url).pathname;
    if (path === PROFILE_REVIEW_SOURCE_PATH) {
      sourceCalls++;
      const raw = await req.text();
      const request = parseProfileReviewSourceRequest(JSON.parse(raw));
      const auth = await svcVerify(httpSecret, { method: "POST", path, headers: req.headers, body: raw, nowS: Math.floor(now / 1000) });
      expect(auth.ok).toBe(true);
      if (!request || !auth.ok) return new Response(null, { status: 403 });
      expect(auth.id).toBe(`${request.review.messageId}:suggestions:source:${request.review.requestNonce}`);
      if (!sourceAllowed(request)) return new Response(null, { status: 403 });
      const proof: Record<string, unknown> = { version: 1, purpose: "network-profile-learning-source-v1", requestSha256: digest(raw),
        requestNonce: request.review.requestNonce, ...identity, personId: request.personId, app: request.review.app, issuedAt: now, expiresAt: now + 5000 };
      alterSource(proof);
      const body = JSON.stringify(proof);
      return new Response(body, { headers: await svcSign(httpSecret, { method: "POST", path, id: `${auth.id}:proof`, body, nowS: Math.floor(now / 1000) }) });
    }
    expect(path).toBe(PROFILE_REVIEW_OWNER_PATH);
    const raw = await req.text();
    const request = parseProfileReviewOwnerRequest(JSON.parse(raw));
    const auth = await svcVerify(httpSecret, { method: "POST", path: PROFILE_REVIEW_OWNER_PATH, headers: req.headers, body: raw, nowS: Math.floor(now / 1000) });
    expect(auth.ok).toBe(true);
    if (!request || !auth.ok) return new Response(null, { status: 403 });
    expect(auth.id).toBe(`${request.messageId}:suggestions:owner:${request.requestNonce}`);
    const proof: Record<string, unknown> = { ...request, ...identity, purpose: "network-profile-review-owner-v1", selectorSha256: digest(raw), issuedAt: now, expiresAt: now + 30_000 };
    alter(proof);
    const body = JSON.stringify(proof);
    return new Response(body, { status: responseStatus, headers: signed ? await svcSign(httpSecret, { method: "POST", path: PROFILE_REVIEW_OWNER_PATH,
      id: `${auth.id}:proof`, body, nowS: Math.floor(now / 1000) }) : {} });
  } });
  const options = { origin: server.url.origin, secret: httpSecret, development: true, routePolicy: policy, now: () => now };
  const resolve = cloudProfileReviewOwner(options);
  return { context, identity, policy, options, async read(c = context) { return sql.begin(tx => resolve(c, tx)); },
    get calls() { return calls; }, setAlter(fn: typeof alter) { alter = fn; }, setSigned(value: boolean) { signed = value; },
    get sourceCalls() { return sourceCalls; }, setSourceAllowed(fn: typeof sourceAllowed) { sourceAllowed = fn; }, setSourceAlter(fn: typeof alterSource) { alterSource = fn; },
    setStatus(value: number) { responseStatus = value; }, stop() { server.stop(true); } };
}

test("owner consumer verifies the actual stored signed turn and signed nonce-bound Cloud proof without caching", async () => {
  const f = await ownerProofFixture();
  try {
    expect(await f.read()).toEqual({ ...f.identity, validUntil: now + 30_000 });
    expect(await f.read()).toEqual({ ...f.identity, validUntil: now + 30_000 });
    expect(f.calls).toBe(2);
    // A valid signature alone cannot choose a different Network person, turn or command.
    for (const wrong of [{ personId: randomUUID() }, { memberId: "other" }, { app: "friends" as const }, { messageId: "missing" },
      { commandSha256: digest("model wording") }, { batchId: randomUUID() }, { action: "preview" as const }])
      expect(await f.read({ ...f.context, ...wrong })).toBeNull();
    expect(f.calls).toBe(2);
    await sql`update platform.inbound set request_hash=null where id='msg:blooio:owner-proof'`;
    expect(await f.read()).toBeNull();
    expect(f.calls).toBe(2);
  } finally { f.stop(); }
});

test("owner consumer rejects wrong selectors, stale/future proofs, unsigned replies, redirects and excess data", async () => {
  const f = await ownerProofFixture();
  try {
    for (const wrong of [{ requestNonce: randomUUID() }, { selectorSha256: digest("other request") }, { app: "friends" }, { memberId: "other" },
      { commandSha256: digest("different command") }, { networkAuthority: { ...f.policy.authority, generation: "other" } },
      { expiresAt: now }, { issuedAt: now + 1 }, { expiresAt: now + 30_001 }, { userId: "unverified-owner" }, { chatId: "other-room" }, { unexpected: true }]) {
      f.setAlter(p => Object.assign(p, wrong));
      expect(await f.read()).toBeNull();
    }
    f.setAlter(() => {});
    f.setSigned(false);
    expect(await f.read()).toBeNull();
    f.setSigned(true);
    f.setStatus(302);
    expect(await f.read()).toBeNull();
    f.setStatus(200);
    f.setAlter(p => { p.excess = "x".repeat(17 * 1024); });
    expect(await f.read()).toBeNull();
  } finally { f.stop(); }
});

test("owner consumer refuses expired routes and stale or future stored turns before any remote lookup", async () => {
  const f = await ownerProofFixture();
  try {
    await sql`update platform.inbound set arrived_at=${new Date(now - 300_000)} where id='msg:blooio:owner-proof'`;
    expect(await f.read()).toBeNull();
    await sql`update platform.inbound set arrived_at=${new Date(now + 1)} where id='msg:blooio:owner-proof'`;
    expect(await f.read()).toBeNull();
    await sql`update platform.inbound set arrived_at=${new Date(now)} where id='msg:blooio:owner-proof'`;
    f.policy.admitUntil = now;
    expect(await f.read()).toBeNull();
    expect(f.calls).toBe(0);
  } finally { f.stop(); }
});

test("valid Cloud proof cannot cross a batch owner or substitute for explicit Network source consent", async () => {
  const f = await ownerProofFixture();
  try {
    const b = (await store.propose(owner, input(), now))!;
    const consumer = cloudProfileReviewOwner(f.options);
    const guarded = new ProfileSuggestions(sql, async () => true, async (who, tx) => {
      const proof = await consumer(f.context, tx);
      return !!proof && who.userId === proof.userId && who.organizationId === proof.organizationId && who.chatId === proof.chatId;
    });
    const decision = { batchId: b.id, revision: 1, decisions: [{ suggestionId: b.suggestions[0]!.id, action: "accept" as const }] };
    expect(await guarded.decide(owner, decision, now)).toEqual({ kind: "denied" });
    expect(await facets()).toHaveLength(0);
    const same = { ...owner, ...f.identity };
    const sourceDenied = new ProfileSuggestions(sql, async () => false);
    const privateStore = new ProfileSuggestions(sql, async () => true);
    const ownBatch = (await privateStore.propose(same, input(), now))!;
    expect(await sourceDenied.decide(same, { batchId: ownBatch.id, revision: 1, decisions: [{ suggestionId: ownBatch.suggestions[0]!.id, action: "accept" }] }, now)).toEqual({ kind: "denied" });
    expect(await facets()).toHaveLength(0);
  } finally { f.stop(); }
});

test("owner lookup has a whole-request deadline with one attempt and refuses insecure origin configuration", async () => {
  const f = await ownerProofFixture();
  try {
    expect(() => cloudProfileReviewOwner({ ...f.options, development: false })).toThrow();
    expect(() => cloudProfileReviewOwner({ ...f.options, origin: "https://example.test/other" })).toThrow();
    let attempts = 0;
    const resolve = cloudProfileReviewOwner({ ...f.options, fetch: Object.assign(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      attempts++; return await new Promise<Response>(() => {});
    }, { preconnect() {} }) });
    const started = performance.now();
    expect(await sql.begin(tx => resolve(f.context, tx))).toBeNull();
    expect(performance.now() - started).toBeLessThan(4000);
    expect(attempts).toBe(1);
  } finally { f.stop(); }
});

test("HTTP cannot save after proof or batch expiry during asynchronous source authorization", async () => {
  for (const expires of ["proof", "batch"]) {
    const b = (await store.propose(owner, input(), now))!;
    const text = `accept ${b.id}.1 1 private`;
    await storedTurn(expires, text);
    let clock: SimClock;
    const http = await reviewHttp(async turn => ({ ...(await boundIdentity(turn, sql))!, validUntil: now + (expires === "proof" ? 1 : 120_000) }),
      async () => { clock.advance(expires === "proof" ? 2 : 60_000); return true; });
    clock = http.clock;
    try {
      expect((await http.post("decide", expires, b.id, { text })).status).toBe(503);
      expect(await facets()).toHaveLength(0);
      expect((await sql`select value,status from platform.profile_suggestions where batch_id=${b.id}`)[0]).toMatchObject({ value: "I enjoy climbing", status: "proposed" });
    } finally { await http.stop(); }
  }
});

test("a fence expiring after database writes rolls the full review transaction back", async () => {
  const b = (await store.propose(owner, input(), now))!;
  for (const editing of [false, true]) {
    let checks = 0;
    const guarded = new ProfileSuggestions(sql, async () => true, undefined, { now: () => now, valid: () => ++checks < (editing ? 3 : 4) });
    await expect(guarded.decide(owner, { batchId: b.id, revision: 1, decisions: [{ suggestionId: b.suggestions[0]!.id, action: "accept",
      ...(editing ? { editedValue: "I enjoy hiking" } : {}) }] }, now)).rejects.toThrow("expired");
    expect(await facets()).toHaveLength(0);
    expect((await sql`select revision from platform.profile_suggestion_batches where id=${b.id}`)[0].revision).toBe(1);
    expect((await sql`select value,status from platform.profile_suggestions where batch_id=${b.id}`)[0]).toMatchObject({ value: "I enjoy climbing", status: "proposed" });
  }
});

async function scopedPending(f: Awaited<ReturnType<typeof ownerProofFixture>>) {
  const who = { ...owner, ...f.identity };
  const connectionId = randomUUID();
  const batch = (await new ProfileSuggestions(sql, async () => true).propose(who, input([{ ...candidate(), connectionId }]), now))!;
  const text = `accept ${batch.id}.1 1 private`;
  f.context.batchId = batch.id;
  f.context.commandSha256 = digest(text);
  await sql`update network.messages set body=${text} where id='in:blooio:owner-proof'`;
  const consent = { connectionId, source: "gmail" as const, windowStart: now - 60_000, windowEnd: now,
    timezone: "America/Los_Angeles", allowedKinds: ["interest" as const], retainOnDisconnect: false };
  return { who, batch, text, consent };
}
async function reviewCommandTurn(f: Awaited<ReturnType<typeof ownerProofFixture>>, id: string, text: string) {
  await storedTurn(id, text);
  await sql`update platform.inbound set request_hash=${digest(`synthetic-signed-${id}`)},network_authority=${f.policy.authority}::jsonb
    where id=${`msg:blooio:${id}`}`;
}

test("review bootstrap defaults off and requires an explicit isolated route, origin and key", async () => {
  expect(profileReviewFromEnv({}, () => now)).toEqual({});
  expect(profileReviewFromEnv({ NETWORK_PROFILE_REVIEW_ENABLED: "0" }, () => now)).toEqual({});
  expect(() => profileReviewFromEnv({ NETWORK_PROFILE_REVIEW_ENABLED: "yes" }, () => now)).toThrow();
  expect(() => profileReviewFromEnv({ NETWORK_PROFILE_REVIEW_ENABLED: "1" }, () => now)).toThrow();
  const f = await ownerProofFixture();
  try {
    const configured = profileReviewFromEnv({ NETWORK_PROFILE_REVIEW_ENABLED: "1", PLATFORM_ENV: "staging",
      NETWORK_ROUTE_AUTHORITY_POLICY: JSON.stringify(f.policy), NETWORK_CLOUD_DELIVERY_ORIGIN: "https://cloud.example", SERVICE_TURN_SECRET: httpSecret }, () => now);
    expect(typeof configured.profileSuggestionIdentity).toBe("function");
    expect(typeof configured.profileSuggestionAuthorization).toBe("function");
    expect(f.calls).toBe(0);
  } finally { f.stop(); }
});

test("the normal service constructor registers the opted-in factory and still defaults missing consent to denied", async () => {
  const f = await ownerProofFixture();
  const p = await scopedPending(f);
  const originalFetch = globalThis.fetch;
  // Only this synthetic origin is redirected in this test process. Signature bytes and both real HTTP handlers are unchanged.
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return originalFetch(url.origin === "https://review-bootstrap.invalid" ? new URL(url.pathname, f.options.origin) : input, init);
  }, { preconnect: originalFetch.preconnect });
  const http = await reviewHttp(undefined, undefined, f.policy, { NETWORK_PROFILE_REVIEW_ENABLED: "1", NETWORK_CLOUD_DELIVERY_ORIGIN: "https://review-bootstrap.invalid" });
  try {
    const args = { text: p.text, networkAuthority: f.policy.authority };
    expect((await http.post("decide", "owner-proof", p.batch.id, args)).status).toBe(403);
    expect(f.sourceCalls).toBe(1);
    f.setSourceAllowed(() => true);
    expect((await http.post("decide", "owner-proof", p.batch.id, args)).body.kind).toBe("saved");
    expect(await facets()).toHaveLength(1);
    const before = f.calls;
    expect(await http.service.profileSuggestions.propose(p.who, input([{ ...candidate(), connectionId: p.consent.connectionId }]), now)).toBeNull();
    expect(f.calls).toBe(before);
  } finally { globalThis.fetch = originalFetch; await http.stop(); f.stop(); }
});

test("source authorization requires this exact transaction's canonical owner and exact requested consent scope", async () => {
  const f = await ownerProofFixture();
  try {
    const p = await scopedPending(f);
    const callbacks = profileReviewFactory(f.options);
    f.setSourceAllowed(request => request.personId === p.who.personId && JSON.stringify(request.consent) === JSON.stringify(p.consent));
    expect(await callbacks.profileSuggestionAuthorization(p.who, p.consent, sql)).toBe(false);
    await sql.begin(async tx => {
      expect(await callbacks.profileSuggestionIdentity(f.context, tx)).toMatchObject(f.identity);
      expect(await callbacks.profileSuggestionAuthorization({ ...p.who, userId: randomUUID() }, p.consent, tx)).toBe(false);
      expect(await callbacks.profileSuggestionAuthorization(p.who, p.consent, sql)).toBe(false);
      for (const wrong of [{ windowStart: p.consent.windowStart - 1 }, { retainOnDisconnect: true }, { connectionId: randomUUID() }, { source: "google_calendar" as const }])
        expect(await callbacks.profileSuggestionAuthorization(p.who, { ...p.consent, ...wrong }, tx)).toBe(false);
      expect(await callbacks.profileSuggestionAuthorization(p.who, p.consent, tx)).toBe(true);
    });
    await sql.begin(async tx => { expect(await callbacks.profileSuggestionAuthorization(p.who, p.consent, tx)).toBe(false); });
  } finally { f.stop(); }
});

test("absent learning permission denies saving but keeps private preview, rejection and deletion usable", async () => {
  const f = await ownerProofFixture();
  const p = await scopedPending(f);
  const callbacks = profileReviewFactory(f.options);
  const http = await reviewHttp(callbacks.profileSuggestionIdentity, callbacks.profileSuggestionAuthorization, f.policy);
  try {
    const networkAuthority = f.policy.authority;
    await reviewCommandTurn(f, "preview-source-denied", `preview ${p.batch.id}`);
    expect((await http.post("preview", "preview-source-denied", p.batch.id, { networkAuthority })).status).toBe(200);
    expect(f.sourceCalls).toBe(0);
    expect((await http.post("decide", "owner-proof", p.batch.id, { text: p.text, networkAuthority })).status).toBe(403);
    expect(f.sourceCalls).toBe(1);
    const text = `reject ${p.batch.id}.1 1`;
    await reviewCommandTurn(f, "reject-source-denied", text);
    expect((await http.post("decide", "reject-source-denied", p.batch.id, { text, networkAuthority })).body).toMatchObject({ kind: "saved", accepted: [], reviewText: "0 saved; 1 rejected." });
    await reviewCommandTurn(f, "delete-source-denied", `delete ${p.batch.id}`);
    expect((await http.post("delete", "delete-source-denied", p.batch.id, { text: `delete ${p.batch.id}`, networkAuthority })).body.kind).toBe("deleted");
    expect(f.sourceCalls).toBe(1);
    expect(await facets()).toHaveLength(0);
    expect(await sql`select id from platform.profile_suggestion_batches`).toHaveLength(0);
  } finally { await http.stop(); f.stop(); }
});

test("only a fresh matching five-second learning proof permits saving; wrong proof fields and old purpose deny", async () => {
  const f = await ownerProofFixture();
  const p = await scopedPending(f);
  const callbacks = profileReviewFactory(f.options);
  const http = await reviewHttp(callbacks.profileSuggestionIdentity, callbacks.profileSuggestionAuthorization, f.policy);
  try {
    f.setSourceAllowed(() => true);
    const args = { text: p.text, networkAuthority: f.policy.authority };
    for (const wrong of [{ purpose: "personal_google_context_v1" }, { requestNonce: randomUUID() }, { requestSha256: digest("other scope") },
      { userId: randomUUID() }, { organizationId: randomUUID() }, { chatId: `personal:${randomUUID()}` }, { personId: randomUUID() },
      { app: "friends" }, { expiresAt: now }, { issuedAt: now + 1 }, { expiresAt: now + 5001 }]) {
      f.setSourceAlter(proof => Object.assign(proof, wrong));
      expect((await http.post("decide", "owner-proof", p.batch.id, args)).status).toBe(403);
      expect(await facets()).toHaveLength(0);
    }
    f.setSourceAlter(() => {});
    expect((await http.post("decide", "owner-proof", p.batch.id, args)).body.kind).toBe("saved");
    expect(await facets()).toEqual([expect.objectContaining({ source: "gmail", inferred: true, confirmedByMember: true, scope: "agent_private" })]);
  } finally { await http.stop(); f.stop(); }
});

test("source proof expiry after authorization rolls saving back while revocation cleanup stays independent", async () => {
  const f = await ownerProofFixture();
  const p = await scopedPending(f);
  let clock: SimClock;
  const callbacks = profileReviewFactory({ ...f.options, now: () => clock?.now() ?? now });
  f.setSourceAllowed(() => true);
  const http = await reviewHttp(callbacks.profileSuggestionIdentity, async (who, consent, tx) => {
    const allowed = await callbacks.profileSuggestionAuthorization(who, consent, tx);
    clock.advance(5000);
    return allowed;
  }, f.policy);
  clock = http.clock;
  try {
    expect((await http.post("decide", "owner-proof", p.batch.id, { text: p.text, networkAuthority: f.policy.authority })).status).toBe(503);
    expect(await facets()).toHaveLength(0);
    expect((await sql`select value,status from platform.profile_suggestions where batch_id=${p.batch.id}`)[0]).toMatchObject({ value: "I enjoy climbing", status: "proposed" });
    // A connector-owned revoke/delete does not need a new collection grant or a source proof.
    await new ProfileSuggestions(sql, async () => false).disconnect(p.who, p.consent.connectionId);
    expect((await sql`select value,status from platform.profile_suggestions where batch_id=${p.batch.id}`)[0]).toMatchObject({ value: null, status: "withdrawn" });
  } finally { await http.stop(); f.stop(); }
});
