import type { Request, Response, NextFunction, RequestHandler } from "express";
import { z, type ZodTypeAny } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Wraps an async handler so rejections reach the error middleware (Express 5 does this too; explicit is clearer). */
export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function parse<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new HttpError(400, "invalid request", {
      issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return r.data;
}

export const idParam = z.coerce.number().int().positive();

export function intId(v: unknown): number {
  return parse(idParam, v);
}
