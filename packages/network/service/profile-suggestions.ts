import { createHash, randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { fold, isSensitiveTerm, type AppId } from "@thenetwork/core";

/** These values come from authenticated server context, never an assistant's arguments. */
export interface SuggestionOwner { userId: string; organizationId: string; personId: string; app: AppId; chatId: string }
export interface SourceSuggestion {
  connectionId: string; source: "gmail" | "google_calendar"; observedAt: number;
  kind: "interest" | "goal" | "availability_pattern"; value: string; tags: string[];
  confidence: number;
  scope: "agent_private" | "matchable";
}
export interface SuggestionReviewBatch {
  id: string; revision: number; status: "pending"; personId: string; app: AppId; chatId: string; expiresAt: number;
  windowStart: number; windowEnd: number; timezone: string; retainOnDisconnect: boolean;
  allowedKinds: SourceSuggestion["kind"][];
  suggestions: (Omit<SourceSuggestion, "connectionId"> & { id: string })[];
}
export interface SuggestionDecision { suggestionId: string; action: "accept" | "reject"; editedValue?: string; scope?: "agent_private" | "matchable" }
export type SuggestionDecisionResult = { kind: "denied" } | { kind: "preview"; batch: SuggestionReviewBatch } | { kind: "saved"; accepted: string[]; rejected: string[] };
/** Must recheck the existing Cloud owner/connection and its consent before each promotion. No connector lives here. */
export interface SuggestionSourceConsent {
  connectionId: string; source: SourceSuggestion["source"]; windowStart: number; windowEnd: number; timezone: string;
  allowedKinds: SourceSuggestion["kind"][]; retainOnDisconnect: boolean;
}
export type SuggestionAuthorization = (owner: SuggestionOwner, consent: SuggestionSourceConsent, tx: SQL) => Promise<boolean>;
const sensitive = (s: string) => (fold(s).match(/\p{L}+/gu) ?? []).some(isSensitiveTerm);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const valueOK = (s: unknown): s is string => typeof s === "string" && s.trim().length >= 2 && s.length <= 400
  && !/(?:https?:\/\/|\b[^\s@]+@[^\s@]+\.[^\s@]+|\+?\d[\d ().-]{7,}\d)/u.test(s)
  && !sensitive(s);

/** Private review storage; only accepted values enter the existing canonical facet table. */
export class ProfileSuggestions {
  constructor(private readonly sql: SQL, private readonly authorize: SuggestionAuthorization,
    private readonly authorizeOwner?: (owner: SuggestionOwner, tx: SQL) => Promise<boolean>) {}

  private async owned(tx: SQL, owner: SuggestionOwner) {
    await tx`select set_config('app.app_id', ${owner.app}, true)`;
    // Use the same person-first order as canonical leave/delete operations.
    await tx`select id from platform.people where id=${owner.personId} for update`;
    const rows = await tx`select n.id,(n.account_status='active' and not n.opted_out and n.age>=18 and p.lowest_age>=18
      and m.state in ('active','onboarding') and m.review is null
      and not exists(select 1 from platform.bans b where b.person_id=p.id or b.phone_hash=p.phone_hash)
      and not exists(select 1 from platform.suppression s where s.phone_hash=p.phone_hash)
      and not exists(select 1 from platform.phone_identities ph where ph.person_id=p.id and ph.hold is not null)) as eligible
      from network.members n join platform.people p on p.id=n.person_id
      join platform.memberships m on m.person_id=p.id and m.app_id=n.app_id
      where n.app_id=${owner.app} and p.id=${owner.personId} and p.deleted_at is null
        and m.state<>'removed' for update of n, m`;
    if (rows[0] && this.authorizeOwner && !await this.authorizeOwner(owner, tx)) return undefined;
    return rows[0] as { id: string; eligible: boolean } | undefined;
  }

  private async batch(tx: SQL, owner: SuggestionOwner, id: string) {
    const member = await this.owned(tx, owner);
    if (!member) return undefined;
    const rows = await tx`select * from platform.profile_suggestion_batches where id=${id} and app_id=${owner.app}
      and person_id=${owner.personId} and member_id=${member.id} and user_id=${owner.userId}
      and organization_id=${owner.organizationId} and chat_id=${owner.chatId} for update`;
    return rows[0] ? { ...rows[0], eligible: member.eligible } : undefined;
  }

  private async view(tx: SQL, b: any, now: number): Promise<SuggestionReviewBatch | null> {
    if (new Date(b.expires_at).getTime() <= now) {
      await tx`update platform.profile_suggestions set status='expired',value=null,tags='{}' where batch_id=${b.id} and status='proposed'`;
      return null;
    }
    const rows = await tx`select * from platform.profile_suggestions where batch_id=${b.id} and status='proposed' order by id`;
    return { id: b.id, revision: b.revision, status: "pending", personId: b.person_id, app: b.app_id, chatId: b.chat_id,
      expiresAt: new Date(b.expires_at).getTime(), windowStart: new Date(b.window_start).getTime(), windowEnd: new Date(b.window_end).getTime(),
      timezone: b.timezone, retainOnDisconnect: b.retain_on_disconnect, allowedKinds: b.allowed_kinds,
      suggestions: rows.map((r: any) => ({ id: r.id, source: r.source, observedAt: new Date(r.observed_at).getTime(), kind: r.kind, value: r.value, tags: r.tags, confidence: r.confidence, scope: r.privacy_scope })) };
  }

  async propose(owner: SuggestionOwner, input: { windowStart: number; windowEnd: number; timezone: string; expiresAt: number; retainOnDisconnect: boolean; allowedKinds: SourceSuggestion["kind"][]; suggestions: SourceSuggestion[] }, now: number): Promise<SuggestionReviewBatch | null> {
    if (!Number.isFinite(now) || !Number.isFinite(input.windowStart) || !Number.isFinite(input.windowEnd)
      || !(input.windowStart < input.windowEnd && input.expiresAt > now)
      || !Number.isFinite(input.expiresAt) || typeof input.retainOnDisconnect !== "boolean"
      || !input.timezone || !input.allowedKinds.length || input.allowedKinds.some(k => !["interest", "goal", "availability_pattern"].includes(k))
      || input.suggestions.length < 1 || input.suggestions.length > 10) return null;
    try { new Intl.DateTimeFormat("en", { timeZone: input.timezone }); } catch { return null; }
    for (const s of input.suggestions) {
      if (!valueOK(s.value) || !input.allowedKinds.includes(s.kind)
        || !["gmail", "google_calendar"].includes(s.source) || !["agent_private", "matchable"].includes(s.scope)
        || !Number.isFinite(s.observedAt) || s.observedAt > now
        || !Number.isFinite(s.confidence) || s.confidence < 0 || s.confidence > 1
        || !s.connectionId || s.connectionId.length > 200
        || s.tags.length > 12 || s.tags.some(t => !/^[a-z][a-z0-9_:-]{0,79}$/u.test(t) || sensitive(t.replace(/[_:]/gu, " ")))) return null;
    }
    return this.sql.begin(async tx => {
      const member = await this.owned(tx, owner);
      if (!member?.eligible) return null;
      for (const s of input.suggestions) if (!await this.authorize(owner, { ...input, connectionId: s.connectionId, source: s.source }, tx)) return null;
      const id = randomUUID();
      const [b] = await tx`insert into platform.profile_suggestion_batches(id,app_id,person_id,member_id,user_id,organization_id,chat_id,created_at,expires_at,window_start,window_end,timezone,allowed_kinds,retain_on_disconnect)
        values(${id},${owner.app},${owner.personId},${member.id},${owner.userId},${owner.organizationId},${owner.chatId},${new Date(now)},${new Date(input.expiresAt)},${new Date(input.windowStart)},${new Date(input.windowEnd)},${input.timezone},${tx.array(input.allowedKinds,"TEXT")},${input.retainOnDisconnect}) returning *`;
      for (const s of input.suggestions) await tx`insert into platform.profile_suggestions(id,batch_id,app_id,connection_id,source,observed_at,kind,confidence,value,tags,original_value_hash,privacy_scope)
        values(${randomUUID()},${id},${owner.app},${s.connectionId},${s.source},${new Date(s.observedAt)},${s.kind},${s.confidence},${s.value.trim()},${tx.array(s.tags,"TEXT")},${hash(s.value.trim())},${s.scope})`;
      return this.view(tx, b, now);
    });
  }

  async getPendingBatch(owner: SuggestionOwner, id: string, now: number): Promise<SuggestionReviewBatch | null> {
    if (!Number.isFinite(now)) return null;
    return this.sql.begin(async tx => { const b = await this.batch(tx, owner, id); return b ? this.view(tx, b, now) : null; });
  }

  async decide(owner: SuggestionOwner, input: { batchId: string; revision: number; decisions: SuggestionDecision[] }, now: number): Promise<SuggestionDecisionResult> {
    if (!Number.isFinite(now)) return { kind: "denied" };
    return this.sql.begin(async tx => {
      const b = await this.batch(tx, owner, input.batchId);
      if (b && new Date(b.expires_at).getTime() <= now) {
        await tx`update platform.profile_suggestions set status='expired',value=null,tags='{}' where batch_id=${b.id} and status='proposed'`;
        return { kind: "denied" };
      }
      if (!b || b.revision !== input.revision
        || !input.decisions.length || new Set(input.decisions.map(d => d.suggestionId)).size !== input.decisions.length) return { kind: "denied" };
      const rows = await tx`select * from platform.profile_suggestions where batch_id=${b.id} order by id for update`;
      for (const d of input.decisions) {
        const s = rows.find((r: any) => r.id === d.suggestionId);
        if (!s || s.status !== "proposed" || !["accept", "reject"].includes(d.action)
          || (d.editedValue !== undefined && (d.action !== "accept" || !valueOK(d.editedValue)))
          || (d.scope !== undefined && !["agent_private", "matchable"].includes(d.scope))
          || (d.action === "accept" && (!b.eligible || !await this.authorize(owner, { connectionId: s.connection_id, source: s.source,
            windowStart: new Date(b.window_start).getTime(), windowEnd: new Date(b.window_end).getTime(), timezone: b.timezone,
            allowedKinds: b.allowed_kinds, retainOnDisconnect: b.retain_on_disconnect }, tx)))) return { kind: "denied" };
      }
      // An edit or scope change is always a new preview, never an implicit acceptance.
      if (input.decisions.some(d => d.editedValue !== undefined || (d.scope !== undefined && d.scope !== rows.find((r: any) => r.id === d.suggestionId).privacy_scope))) {
        for (const d of input.decisions) if (d.action === "accept") await tx`update platform.profile_suggestions
          set value=coalesce(${d.editedValue?.trim() ?? null},value),privacy_scope=coalesce(${d.scope ?? null},privacy_scope),
            tags=case when ${d.editedValue !== undefined} then '{}'::text[] else tags end where id=${d.suggestionId}`;
        const [updated] = await tx`update platform.profile_suggestion_batches set revision=revision+1 where id=${b.id} returning *`;
        return { kind: "preview", batch: (await this.view(tx, updated, now))! };
      }
      const accepted: string[] = [], rejected: string[] = [];
      for (const d of input.decisions) {
        const s = rows.find((r: any) => r.id === d.suggestionId)!;
        if (d.action === "accept") {
          const factId = `source-suggestion:${s.id}`;
          await tx`insert into network.facets(app_id,id,member_id,kind,value,tags,privacy_scope,provenance,source,confidence,status,valid_from,observed_at)
            values(${owner.app},${factId},${b.member_id},${s.kind},${s.value},${tx.array(s.tags,"TEXT")},${s.privacy_scope},'inferred',${s.source},${s.confidence},'confirmed',${new Date(s.observed_at)},${new Date(s.observed_at)})`;
          await tx`update platform.profile_suggestions set status='accepted',fact_id=${factId},value=null,tags='{}' where id=${s.id}`;
          accepted.push(s.id);
        } else {
          await tx`update platform.profile_suggestions set status='rejected',value=null,tags='{}' where id=${s.id}`;
          rejected.push(s.id);
        }
      }
      await tx`update platform.profile_suggestion_batches set revision=revision+1 where id=${b.id}`;
      return { kind: "saved", accepted, rejected };
    });
  }

  async deleteBatch(owner: SuggestionOwner, id: string): Promise<boolean> {
    return this.sql.begin(async tx => {
      const b = await this.batch(tx, owner, id);
      if (!b) return false;
      await tx`delete from platform.profile_suggestion_batches where id=${b.id}`;
      return true;
    });
  }

  /** Called only after the existing connector owner revokes the connection. */
  async disconnect(owner: SuggestionOwner, connectionId: string): Promise<void> {
    await this.sql.begin(async tx => {
      const member = await this.owned(tx, owner);
      if (!member) return;
      const batches = await tx`select * from platform.profile_suggestion_batches where app_id=${owner.app} and person_id=${owner.personId}
        and member_id=${member.id} and user_id=${owner.userId} and organization_id=${owner.organizationId} for update`;
      for (const b of batches) {
        const rows = await tx`select * from platform.profile_suggestions where batch_id=${b.id} and connection_id=${connectionId} for update`;
        for (const s of rows) {
          if (s.status === "accepted" && b.retain_on_disconnect) continue;
          if (s.fact_id) await tx`delete from network.facets where id=${s.fact_id} and app_id=${owner.app}`;
          await tx`update platform.profile_suggestions set status='withdrawn',value=null,tags='{}',fact_id=null where id=${s.id}`;
        }
        await tx`update platform.profile_suggestion_batches set revision=revision+1 where id=${b.id}`;
      }
    });
  }

  /** Internal tick cleanup; no owner needs to return to an expired preview. */
  async expirePending(app: AppId, now: number): Promise<void> {
    if (!Number.isFinite(now)) return;
    await this.sql.begin(async tx => {
      await tx`select set_config('app.app_id', ${app}, true)`;
      await tx`with expired as (select b.id from platform.profile_suggestion_batches b where b.app_id=${app}
        and b.expires_at<=${new Date(now)} and exists(select 1 from platform.profile_suggestions s where s.batch_id=b.id and s.status='proposed')
        order by b.expires_at limit 100 for update skip locked)
        update platform.profile_suggestions s set status='expired',value=null,tags='{}'
        from expired e where s.batch_id=e.id and s.app_id=${app} and s.status='proposed'`;
    });
  }
}
