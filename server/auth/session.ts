import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { Principal, SessionData } from "./types.ts";

export const SESSION_COOKIE = "sv_session";

export interface SessionOptions {
  secret: string;
  ttlSec: number;
  secure: boolean;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function encodeSession(data: SessionData, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(data), "utf8"));
  return `${payload}.${sign(payload, secret)}`;
}

export function decodeSession(token: string | undefined, secret: string): SessionData | null {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionData;
    if (!data || typeof data.exp !== "number" || data.exp * 1000 < Date.now()) return null;
    if (typeof data.csrf !== "string" || typeof data.sub !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

export function newSession(principal: Principal, ttlSec: number): SessionData {
  return {
    ...principal,
    csrf: crypto.randomBytes(24).toString("base64url"),
    exp: Math.floor(Date.now() / 1000) + ttlSec,
  };
}

export function setSessionCookie(res: Response, data: SessionData, opts: SessionOptions): void {
  res.cookie(SESSION_COOKIE, encodeSession(data, opts.secret), {
    httpOnly: true,
    secure: opts.secure,
    sameSite: "lax",
    path: "/",
    maxAge: opts.ttlSec * 1000,
  });
}

export function clearSessionCookie(res: Response, opts: SessionOptions): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: opts.secure, sameSite: "lax", path: "/" });
}

export function readSession(req: Request, secret: string): SessionData | null {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
  return decodeSession(cookies[SESSION_COOKIE], secret);
}
