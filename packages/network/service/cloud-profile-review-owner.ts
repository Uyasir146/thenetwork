import { createHash, randomUUID } from "node:crypto";
import { readCapped } from "../../platform/src/body.ts";
import { isAppId } from "../../platform/src/apps.ts";
import { PROFILE_REVIEW_OWNER_PATH as OWNER_PATH, parseProfileReviewOwnerRequest, parseProfileReviewOwnerProof } from "../../core/src/svc/profile-review-owner.ts";
import { svcSign, svcVerify } from "../../core/src/svc/svc-auth.ts";
import { routeEnvelopeAllowed, sameNetworkAuthority, type NetworkRoutePolicy } from "./route-authority.ts";
import type { SuggestionIdentityResolver } from "./profile-suggestion-endpoint.ts";

const MAX_PARENT_AGE_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export interface CloudProfileReviewOwnerOptions {
  origin: string; secret: string; routePolicy: NetworkRoutePolicy; now: () => number;
  /** Only explicit development may use a loopback HTTP origin. */
  development?: boolean;
  fetch?: typeof fetch;
}

/** No cached owner, retry or identity fallback. This only consumes an existing attested turn. */
export function cloudProfileReviewOwner(o: CloudProfileReviewOwnerOptions): SuggestionIdentityResolver {
  const origin = new URL(o.origin);
  const local = o.development && origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname);
  if ((!local && origin.protocol !== "https:") || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/"
    || o.secret.length < 32) throw new Error("Profile review owner requires an exact trusted origin and service secret");
  return async (context, tx) => {
    try {
      const now = o.now();
      if (!Number.isSafeInteger(now) || !isAppId(context.app) || !UUID.test(context.personId)
        || !UUID.test(context.batchId) || !/^[a-f0-9]{64}$/u.test(context.commandSha256)
        || !context.networkAuthority || now >= o.routePolicy.admitUntil
        || !routeEnvelopeAllowed(o.routePolicy, context.networkAuthority, now)) return null;
      await tx`select set_config('app.app_id',${context.app},true)`;
      // The context is a server hint. The stored signed turn and its current member remain authority.
      const [turn] = await tx`select i.request_hash,i.arrived_at,i.network_authority,i.response,m.body
        from platform.inbound i join platform.people p on p.phone_hash=i.sender_hash
        join network.members n on n.person_id=p.id and n.app_id=${context.app} and n.id=${context.memberId}
        join platform.memberships pm on pm.person_id=p.id and pm.app_id=n.app_id and pm.member_id=n.id
        join network.messages m on m.app_id=n.app_id and m.member_id=n.id and m.id=${`in:${context.channel}:${context.messageId}`} and m.direction='inbound'
        where i.id=${`msg:${context.channel}:${context.messageId}`} and i.status='done' and p.id=${context.personId}
        and p.deleted_at is null and pm.state<>'removed'`;
      if (!turn || !/^[a-f0-9]{64}$/u.test(turn.request_hash ?? "") || turn.response?.outcome !== "open"
        || turn.response.app !== context.app || turn.response.memberId !== context.memberId
        || !sameNetworkAuthority(turn.network_authority, context.networkAuthority)
        || typeof turn.body !== "string" || sha256(turn.body) !== context.commandSha256) return null;
      // This narrows dispatch only; the canonical review parser still owns the exact decision.
      const command = turn.body.trim();
      if (context.action === "preview" || context.action === "delete") {
        if (command !== `${context.action} ${context.batchId}`) return null;
      } else if (!["accept", "reject", "edit"].some(verb => command.startsWith(`${verb} ${context.batchId}.`))) return null;
      const arrivedAt = new Date(turn.arrived_at).getTime();
      if (!Number.isSafeInteger(arrivedAt) || arrivedAt > now || now - arrivedAt >= MAX_PARENT_AGE_MS) return null;
      const requestNonce = randomUUID();
      const selector = parseProfileReviewOwnerRequest({ version: 1, channel: context.channel, messageId: context.messageId, app: context.app, memberId: context.memberId,
        batchId: context.batchId, action: context.action, commandSha256: context.commandSha256, networkAuthority: context.networkAuthority, requestNonce });
      if (!selector) return null;
      const body = JSON.stringify(selector), id = `${context.messageId}:suggestions:owner:${requestNonce}`;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, 3000); });
      try {
        const request = (async () => {
          const response = await (o.fetch ?? fetch)(origin.origin + OWNER_PATH, { method: "POST", redirect: "manual", signal: controller.signal,
          headers: { "Content-Type": "application/json", ...await svcSign(o.secret, { method: "POST", path: OWNER_PATH, id, body, nowS: Math.floor(now / 1000) }) }, body });
          if (controller.signal.aborted || response.status !== 200) return null;
          const bytes = await readCapped(response, 16 * 1024);
          if (controller.signal.aborted || bytes === "too_large") return null;
          const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          const auth = await svcVerify(o.secret, { method: "POST", path: OWNER_PATH, headers: response.headers, body: raw, nowS: Math.floor(o.now() / 1000) });
          if (!auth.ok || auth.id !== `${id}:proof`) return null;
          const after = o.now();
          const proof = parseProfileReviewOwnerProof(JSON.parse(raw), selector, sha256(body), after);
          if (!proof || after >= o.routePolicy.admitUntil || proof.expiresAt > o.routePolicy.admitUntil
            || !routeEnvelopeAllowed(o.routePolicy, proof.networkAuthority, after)) return null;
          return { userId: proof.userId, organizationId: proof.organizationId, chatId: proof.chatId, validUntil: proof.expiresAt };
        })().catch(() => null);
        return await Promise.race([request, deadline]);
      } finally { clearTimeout(timer!); controller.abort(); }
    } catch { return null; }
  };
}
