import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import {
  createParty,
  getPartyDetail,
  listMarkets,
  listParties,
  ROLE_STATUS_VALUES,
  ROLE_VALUES,
  updateParty,
  updateRole,
  upsertAffiliation,
  upsertRole,
} from "../services/people.ts";
import { HttpError, intId, parse, wrap } from "./util.ts";
import { refileAfterChange } from "../workspaces/refileHook.ts";
import { requireOwner, scopeOf } from "../auth/scope.ts";

const listSchema = z.object({
  q: z.string().max(100).optional(),
  kind: z.enum(["person", "org"]).optional(),
  workspace: z.string().max(100).optional(),
  role: z.enum(ROLE_VALUES).optional(),
  status: z.enum(ROLE_STATUS_VALUES).optional(),
  market: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const strList = z.array(z.string().trim().min(1).max(200)).max(20);
const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    emails: strList.optional(),
    phones: strList.optional(),
    location: z.string().trim().max(200).nullable().optional(),
    website: z.string().trim().max(300).nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
  })
  .strict();

const createSchema = z.object({
  kind: z.enum(["person", "org"]),
  name: z.string().trim().min(1).max(200),
  emails: strList.optional(),
  phones: strList.optional(),
  location: z.string().trim().max(200).nullable().optional(),
  /** Optional first role so a new person lands in a workspace right away. */
  role: z.object({ workspaceId: z.string().max(100), role: z.enum(ROLE_VALUES), status: z.enum(ROLE_STATUS_VALUES).optional(), market: z.string().max(100).nullable().optional(), detail: z.string().max(300).nullable().optional() }).optional(),
});

const roleSchema = z.object({
  workspaceId: z.string().max(100),
  role: z.enum(ROLE_VALUES),
  status: z.enum(ROLE_STATUS_VALUES).optional(),
  market: z.string().trim().max(100).nullable().optional(),
  detail: z.string().trim().max(300).nullable().optional(),
});

const rolePatchSchema = z
  .object({
    status: z.enum(ROLE_STATUS_VALUES).optional(),
    market: z.string().trim().max(100).nullable().optional(),
    detail: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

export function peopleRouter(ctx: AppContext): Router {
  const r = Router();

  r.get(
    "/",
    wrap(async (req, res) => {
      const q = parse(listSchema, req.query);
      const scope = scopeOf(req.session);
      const items = await listParties(ctx.pool, {
        q: q.q,
        kind: q.kind,
        workspaceId: scope.owner ? q.workspace : scope.workspaceId,
        role: q.role,
        status: q.status,
        market: q.market,
        limit: q.limit,
      });
      // Contractors get names for tagging, not contact details.
      res.json({ items: scope.owner ? items : items.map((p) => ({ ...p, emails: [], location: null, orgs: [] })) });
    }),
  );

  r.use(requireOwner());

  r.get(
    "/markets",
    wrap(async (req, res) => {
      res.json({ items: await listMarkets(ctx.pool, typeof req.query.workspace === "string" ? req.query.workspace : null) });
    }),
  );

  r.post(
    "/",
    wrap(async (req, res) => {
      const body = parse(createSchema, req.body);
      const id = await createParty(ctx.pool, body);
      if (body.role) {
        const ws = await ctx.pool.query(`select 1 from workspaces where id = $1`, [body.role.workspaceId]);
        if (!ws.rowCount) throw new HttpError(400, "unknown workspace");
        await upsertRole(ctx.pool, id, body.role);
        await refileAfterChange(ctx, [id]);
      }
      res.status(201).json(await getPartyDetail(ctx.pool, id));
    }),
  );

  r.get(
    "/:id",
    wrap(async (req, res) => {
      const party = await getPartyDetail(ctx.pool, intId(req.params.id));
      if (!party) throw new HttpError(404, "person not found");
      res.json(party);
    }),
  );

  r.patch(
    "/:id",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const patch = parse(patchSchema, req.body);
      if (!(await updateParty(ctx.pool, id, patch))) throw new HttpError(404, "person not found");
      res.json(await getPartyDetail(ctx.pool, id));
    }),
  );

  r.post(
    "/:id/roles",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const body = parse(roleSchema, req.body);
      const ws = await ctx.pool.query(`select 1 from workspaces where id = $1`, [body.workspaceId]);
      if (!ws.rowCount) throw new HttpError(400, "unknown workspace");
      const party = await ctx.pool.query(`select 1 from parties where id = $1`, [id]);
      if (!party.rowCount) throw new HttpError(404, "person not found");
      await upsertRole(ctx.pool, id, body);
      await refileAfterChange(ctx, [id]);
      res.status(201).json(await getPartyDetail(ctx.pool, id));
    }),
  );

  r.post(
    "/:id/affiliations",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const body = parse(z.object({ orgId: z.coerce.number().int().positive(), title: z.string().trim().max(200).nullable().optional() }), req.body);
      const kinds = await ctx.pool.query(`select id, kind from parties where id = any($1::bigint[])`, [[id, body.orgId]]);
      const me = kinds.rows.find((k) => k.id === id);
      const org = kinds.rows.find((k) => k.id === body.orgId);
      if (!me) throw new HttpError(404, "person not found");
      if (!org) throw new HttpError(400, "unknown organization");
      const [personId, orgId] = me.kind === "org" ? [body.orgId, id] : [id, body.orgId];
      await upsertAffiliation(ctx.pool, personId, orgId, body.title ?? null);
      await refileAfterChange(ctx, [personId]);
      res.status(201).json(await getPartyDetail(ctx.pool, id));
    }),
  );

  return r;
}

export function rolesRouter(ctx: AppContext): Router {
  const r = Router();
  r.patch(
    "/:id",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const patch = parse(rolePatchSchema, req.body);
      if (!(await updateRole(ctx.pool, id, patch))) throw new HttpError(404, "role not found");
      const { rows } = await ctx.pool.query(`select party_id from roles where id = $1`, [id]);
      res.json(await getPartyDetail(ctx.pool, rows[0].party_id));
    }),
  );
  return r;
}
