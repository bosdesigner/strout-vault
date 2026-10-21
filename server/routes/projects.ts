import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { addProjectParty, createProject, getProject, listProjects, updateProject } from "../services/projects.ts";
import { HttpError, intId, parse, wrap } from "./util.ts";

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    address: z.string().trim().max(300).nullable().optional(),
    status: z.string().trim().max(60).nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
  })
  .strict();

export function projectsRouter(ctx: AppContext): Router {
  const r = Router();
  r.get(
    "/",
    wrap(async (req, res) => {
      const q = parse(z.object({ workspace: z.string().max(100).optional(), status: z.string().max(60).optional(), q: z.string().max(100).optional() }), req.query);
      res.json({ items: await listProjects(ctx.pool, { workspaceId: q.workspace, status: q.status, q: q.q }) });
    }),
  );
  r.post(
    "/",
    wrap(async (req, res) => {
      const body = parse(z.object({ workspaceId: z.string().max(100), name: z.string().trim().min(1).max(200), address: z.string().trim().max(300).nullable().optional(), status: z.string().trim().max(60).nullable().optional() }), req.body);
      const ws = await ctx.pool.query(`select 1 from workspaces where id = $1`, [body.workspaceId]);
      if (!ws.rowCount) throw new HttpError(400, "unknown workspace");
      const id = await createProject(ctx.pool, body);
      res.status(201).json(await getProject(ctx.pool, id));
    }),
  );
  r.get(
    "/:id",
    wrap(async (req, res) => {
      const project = await getProject(ctx.pool, intId(req.params.id));
      if (!project) throw new HttpError(404, "project not found");
      res.json(project);
    }),
  );
  r.patch(
    "/:id",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const patch = parse(patchSchema, req.body);
      if (!(await updateProject(ctx.pool, id, patch))) throw new HttpError(404, "project not found");
      res.json(await getProject(ctx.pool, id));
    }),
  );
  r.post(
    "/:id/parties",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const body = parse(z.object({ partyId: z.coerce.number().int().positive(), role: z.string().trim().min(1).max(60) }), req.body);
      if (!(await getProject(ctx.pool, id))) throw new HttpError(404, "project not found");
      const party = await ctx.pool.query(`select 1 from parties where id = $1`, [body.partyId]);
      if (!party.rowCount) throw new HttpError(400, "unknown person");
      await addProjectParty(ctx.pool, id, body.partyId, body.role);
      res.status(201).json(await getProject(ctx.pool, id));
    }),
  );
  return r;
}
