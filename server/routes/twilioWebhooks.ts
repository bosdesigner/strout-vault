import express, { Router } from "express";
import type { AppContext } from "../context.ts";
import { escapeXml, validateTwilioSignature } from "../twilio/signature.ts";
import { DEFAULT_NOTICE, findTrackedNumber, ingestRecording, recordCallStatus, recordIncomingCall } from "../services/calls.ts";
import { wrap } from "./util.ts";

/**
 * Twilio voice webhooks for tracked numbers. Point the number's voice URL at
 * POST {PUBLIC_URL}/webhooks/twilio/voice. Every request must carry a valid
 * X-Twilio-Signature for the URL Twilio called (built from PUBLIC_URL, so a
 * proxy in front cannot change it) and the form body.
 */
export function twilioWebhooksRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(express.urlencoded({ extended: false, limit: "256kb" }));

  const twiml = (res: express.Response, body: string) => {
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
  };

  r.use((req, res, next) => {
    const { TWILIO_AUTH_TOKEN, PUBLIC_URL } = ctx.config;
    if (!TWILIO_AUTH_TOKEN || !ctx.config.TWILIO_ACCOUNT_SID) {
      res.status(503).type("text").send("Twilio is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)");
      return;
    }
    const base = PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
    const url = `${base.replace(/\/$/, "")}${req.originalUrl}`;
    const params = (req.body ?? {}) as Record<string, string>;
    if (!validateTwilioSignature(TWILIO_AUTH_TOKEN, url, params, req.get("x-twilio-signature"))) {
      res.status(403).type("text").send("bad signature");
      return;
    }
    next();
  });

  // Incoming call: play the notice, record, forward to the contractor.
  r.post(
    "/voice",
    wrap(async (req, res) => {
      const p = req.body as Record<string, string>;
      const tn = await findTrackedNumber(ctx.pool, p.To);
      if (!tn || tn.status !== "active") {
        twiml(res, `<Say>This number is not in service.</Say><Hangup/>`);
        return;
      }
      await recordIncomingCall(ctx.pool, tn, { callSid: p.CallSid, from: p.From ?? null, to: p.To ?? null, raw: p });
      const base = (ctx.config.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
      const notice = escapeXml(tn.recordingNotice || DEFAULT_NOTICE);
      twiml(
        res,
        `<Say voice="Polly.Joanna">${notice}</Say>` +
          `<Dial record="record-from-answer-dual" timeout="25" action="${base}/webhooks/twilio/status" ` +
          `recordingStatusCallback="${base}/webhooks/twilio/recording" recordingStatusCallbackEvent="completed">` +
          `<Number>${escapeXml(tn.forwardTo)}</Number></Dial>`,
      );
    }),
  );

  // After <Dial> finishes: outcome and duration.
  r.post(
    "/status",
    wrap(async (req, res) => {
      const p = req.body as Record<string, string>;
      const status = p.DialCallStatus ?? p.CallStatus ?? null;
      const duration = p.DialCallDuration ? Number(p.DialCallDuration) : p.CallDuration ? Number(p.CallDuration) : null;
      await recordCallStatus(ctx.pool, p.CallSid, status, Number.isFinite(duration as number) ? duration : null, p);
      twiml(res, `<Hangup/>`);
    }),
  );

  // Recording ready: copy it into the vault and queue transcription.
  r.post(
    "/recording",
    wrap(async (req, res) => {
      const p = req.body as Record<string, string>;
      if ((p.RecordingStatus ?? "completed") !== "completed" || !p.RecordingUrl || !p.CallSid) {
        res.status(204).end();
        return;
      }
      try {
        const out = await ingestRecording(
          { pool: ctx.pool, storage: ctx.storage, fetchImpl: ctx.fetchImpl, twilio: { accountSid: ctx.config.TWILIO_ACCOUNT_SID!, authToken: ctx.config.TWILIO_AUTH_TOKEN! } },
          { callSid: p.CallSid, recordingSid: p.RecordingSid ?? "", recordingUrl: p.RecordingUrl, durationSec: p.RecordingDuration ? Number(p.RecordingDuration) : null },
        );
        res.json({ ok: true, ...out });
      } catch (err) {
        // Twilio retries on 5xx; the failure is also recorded on the call row.
        console.error("[twilio] recording ingest failed:", err instanceof Error ? err.message : err);
        res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "ingest failed" });
      }
    }),
  );

  return r;
}
