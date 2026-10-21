import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { normalizePhone } from "../twilio/signature.ts";
import { HttpError, intId, parse, wrap } from "./util.ts";

const MEMBERSHIP_SELECT = `
  select m.id, m.email, m.role, m.workspace_id, w.name as workspace_name, m.party_id, p.name as party_name,
         m.status, m.display_name, m.created_at, m.last_login_at,
         (select count(*)::int from tracked_numbers tn where tn.membership_id = m.id) as numbers
  from memberships m
  left join workspaces w on w.id = m.workspace_id
  left join parties p on p.id = m.party_id`;

function membershipRow(r: Record<string, unknown>) {
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    partyId: r.party_id,
    partyName: r.party_name,
    status: r.status,
    displayName: r.display_name,
    createdAt: r.created_at ? new Date(r.created_at as string).toISOString() : null,
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at as string).toISOString() : null,
    trackedNumbers: r.numbers,
  };
}

function baseUrl(req: { protocol: string; get(h: string): string | undefined }, configured: string): string {
  return configured || `${req.protocol}://${req.get("host")}`;
}

/** Owner-only: who can log in. */
export function membershipsRouter(ctx: AppContext): Router {
  const r = Router();
  r.get(
    "/",
    wrap(async (_req, res) => {
      const { rows } = await ctx.pool.query(`${MEMBERSHIP_SELECT} order by m.status = 'disabled', w.name nulls first, m.email`);
      res.json({ items: rows.map(membershipRow) });
    }),
  );
  r.post(
    "/",
    wrap(async (req, res) => {
      const body = parse(
        z.object({
          email: z.string().trim().email().max(200),
          workspaceId: z.string().max(100),
          partyId: z.coerce.number().int().positive().nullable().optional(),
          displayName: z.string().trim().max(200).nullable().optional(),
          sendLink: z.boolean().optional(),
        }),
        req.body,
      );
      const ws = await ctx.pool.query(`select 1 from workspaces where id = $1`, [body.workspaceId]);
      if (!ws.rowCount) throw new HttpError(400, "unknown workspace");
      if (body.partyId) {
        const party = await ctx.pool.query(`select 1 from parties where id = $1`, [body.partyId]);
        if (!party.rowCount) throw new HttpError(400, "unknown person");
      }
      const dup = await ctx.pool.query(`select 1 from memberships where lower(email) = lower($1) and coalesce(workspace_id, '') = $2`, [body.email, body.workspaceId]);
      if (dup.rowCount) throw new HttpError(409, "that email already has access to this workspace");
      const { rows } = await ctx.pool.query(
        `insert into memberships (email, role, workspace_id, party_id, status, display_name, invited_by) values ($1, 'contractor', $2, $3, 'invited', $4, $5) returning id`,
        [body.email, body.workspaceId, body.partyId ?? null, body.displayName ?? null, req.session?.email ?? null],
      );
      if (body.sendLink !== false) await ctx.auth.requestMagicLink(body.email, { ip: req.ip ?? null, baseUrl: baseUrl(req, ctx.config.PUBLIC_URL) });
      const out = await ctx.pool.query(`${MEMBERSHIP_SELECT} where m.id = $1`, [rows[0].id]);
      res.status(201).json(membershipRow(out.rows[0]));
    }),
  );
  r.patch(
    "/:id",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const body = parse(
        z.object({ status: z.enum(["invited", "active", "disabled"]).optional(), partyId: z.coerce.number().int().positive().nullable().optional(), displayName: z.string().trim().max(200).nullable().optional() }).strict(),
        req.body,
      );
      const sets: string[] = [];
      const params: unknown[] = [];
      const p = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      if (body.status !== undefined) sets.push(`status = ${p(body.status)}`);
      if (body.partyId !== undefined) sets.push(`party_id = ${p(body.partyId)}`);
      if (body.displayName !== undefined) sets.push(`display_name = ${p(body.displayName)}`);
      if (sets.length) {
        const upd = await ctx.pool.query(`update memberships set ${sets.join(", ")} where id = ${p(id)}`, params);
        if (!upd.rowCount) throw new HttpError(404, "membership not found");
      }
      const out = await ctx.pool.query(`${MEMBERSHIP_SELECT} where m.id = $1`, [id]);
      if (!out.rows[0]) throw new HttpError(404, "membership not found");
      res.json(membershipRow(out.rows[0]));
    }),
  );
  r.post(
    "/:id/send-link",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const { rows } = await ctx.pool.query(`select email, status from memberships where id = $1`, [id]);
      if (!rows[0]) throw new HttpError(404, "membership not found");
      if (rows[0].status === "disabled") throw new HttpError(409, "membership is disabled");
      await ctx.auth.requestMagicLink(rows[0].email, { ip: req.ip ?? null, baseUrl: baseUrl(req, ctx.config.PUBLIC_URL) });
      res.json({ ok: true });
    }),
  );
  return r;
}

const NUMBER_SELECT = `
  select tn.*, w.name as workspace_name, p.name as party_name, m.email as membership_email,
         (select count(*)::int from calls c where c.tracked_number_id = tn.id) as call_count,
         (select max(c.started_at) from calls c where c.tracked_number_id = tn.id) as last_call_at
  from tracked_numbers tn
  left join workspaces w on w.id = tn.workspace_id
  left join parties p on p.id = tn.party_id
  left join memberships m on m.id = tn.membership_id`;

function numberRow(r: Record<string, unknown>) {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    membershipId: r.membership_id,
    membershipEmail: r.membership_email,
    partyId: r.party_id,
    partyName: r.party_name,
    phoneNumber: r.phone_number,
    forwardTo: r.forward_to,
    twilioSid: r.twilio_sid,
    recordingNotice: r.recording_notice,
    status: r.status,
    callCount: r.call_count,
    lastCallAt: r.last_call_at ? new Date(r.last_call_at as string).toISOString() : null,
    createdAt: r.created_at ? new Date(r.created_at as string).toISOString() : null,
  };
}

const phone = z.string().trim().min(7).max(25).transform((v, c) => {
  const n = normalizePhone(v);
  if (!n || n.length < 8) {
    c.addIssue({ code: z.ZodIssueCode.custom, message: "enter a phone number like +1 713 555 0100" });
    return z.NEVER;
  }
  return n;
});

/** Owner-only: tracked (forwarding) numbers. Numbers are bought in the Twilio console, never from here. */
export function trackedNumbersRouter(ctx: AppContext): Router {
  const r = Router();
  r.get(
    "/",
    wrap(async (_req, res) => {
      const { rows } = await ctx.pool.query(`${NUMBER_SELECT} order by tn.status = 'released', tn.created_at desc`);
      res.json({
        items: rows.map(numberRow),
        webhookUrl: ctx.config.PUBLIC_URL ? `${ctx.config.PUBLIC_URL.replace(/\/$/, "")}/webhooks/twilio/voice` : null,
        twilioConfigured: !!(ctx.config.TWILIO_ACCOUNT_SID && ctx.config.TWILIO_AUTH_TOKEN),
      });
    }),
  );
  r.post(
    "/",
    wrap(async (req, res) => {
      const body = parse(
        z.object({
          phoneNumber: phone,
          forwardTo: phone,
          workspaceId: z.string().max(100),
          partyId: z.coerce.number().int().positive(),
          membershipId: z.coerce.number().int().positive().nullable().optional(),
          recordingNotice: z.string().trim().max(500).nullable().optional(),
          twilioSid: z.string().trim().max(64).nullable().optional(),
        }),
        req.body,
      );
      const ws = await ctx.pool.query(`select 1 from workspaces where id = $1`, [body.workspaceId]);
      if (!ws.rowCount) throw new HttpError(400, "unknown workspace");
      const party = await ctx.pool.query(`select 1 from parties where id = $1`, [body.partyId]);
      if (!party.rowCount) throw new HttpError(400, "unknown person");
      const dup = await ctx.pool.query(`select 1 from tracked_numbers where phone_number = $1`, [body.phoneNumber]);
      if (dup.rowCount) throw new HttpError(409, "that number is already tracked");
      const { rows } = await ctx.pool.query(
        `insert into tracked_numbers (workspace_id, membership_id, party_id, phone_number, forward_to, twilio_sid, recording_notice) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [body.workspaceId, body.membershipId ?? null, body.partyId, body.phoneNumber, body.forwardTo, body.twilioSid ?? null, body.recordingNotice ?? null],
      );
      const out = await ctx.pool.query(`${NUMBER_SELECT} where tn.id = $1`, [rows[0].id]);
      res.status(201).json(numberRow(out.rows[0]));
    }),
  );
  r.patch(
    "/:id",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const body = parse(z.object({ status: z.enum(["active", "paused", "released"]).optional(), forwardTo: phone.optional(), recordingNotice: z.string().trim().max(500).nullable().optional() }).strict(), req.body);
      const sets: string[] = [];
      const params: unknown[] = [];
      const p = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      if (body.status !== undefined) sets.push(`status = ${p(body.status)}`);
      if (body.forwardTo !== undefined) sets.push(`forward_to = ${p(body.forwardTo)}`);
      if (body.recordingNotice !== undefined) sets.push(`recording_notice = ${p(body.recordingNotice)}`);
      if (sets.length) {
        const upd = await ctx.pool.query(`update tracked_numbers set ${sets.join(", ")} where id = ${p(id)}`, params);
        if (!upd.rowCount) throw new HttpError(404, "number not found");
      }
      const out = await ctx.pool.query(`${NUMBER_SELECT} where tn.id = $1`, [id]);
      if (!out.rows[0]) throw new HttpError(404, "number not found");
      res.json(numberRow(out.rows[0]));
    }),
  );
  return r;
}

/** Owner-only: recent calls on tracked numbers. */
export function callsRouter(ctx: AppContext): Router {
  const r = Router();
  r.get(
    "/",
    wrap(async (req, res) => {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const { rows } = await ctx.pool.query(
        `select c.id, c.call_sid, c.from_number, c.to_number, c.started_at, c.ended_at, c.duration_sec, c.status,
                c.recording_status, c.recording_error, c.interaction_id, c.caller_party_id, p.name as caller_name,
                tn.phone_number as tracked_number, tn.party_id as owner_party_id, o.name as owner_name, i.title as interaction_title, i.pipeline_status
         from calls c
         left join tracked_numbers tn on tn.id = c.tracked_number_id
         left join parties p on p.id = c.caller_party_id
         left join parties o on o.id = tn.party_id
         left join interactions i on i.id = c.interaction_id
         order by c.started_at desc nulls last, c.id desc limit $1`,
        [limit],
      );
      res.json({
        items: rows.map((c) => ({
          id: c.id,
          callSid: c.call_sid,
          from: c.from_number,
          to: c.to_number,
          startedAt: c.started_at ? new Date(c.started_at).toISOString() : null,
          endedAt: c.ended_at ? new Date(c.ended_at).toISOString() : null,
          durationSec: c.duration_sec,
          status: c.status,
          recordingStatus: c.recording_status,
          recordingError: c.recording_error,
          interactionId: c.interaction_id,
          interactionTitle: c.interaction_title,
          pipelineStatus: c.pipeline_status,
          caller: c.caller_party_id ? { id: c.caller_party_id, name: c.caller_name } : null,
          trackedNumber: c.tracked_number,
          owner: c.owner_party_id ? { id: c.owner_party_id, name: c.owner_name } : null,
        })),
      });
    }),
  );
  return r;
}
