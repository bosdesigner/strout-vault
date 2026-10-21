import { describe, expect, it } from "vitest";
import { escapeXml, normalizePhone, twilioSignature, validateTwilioSignature } from "../../server/twilio/signature.ts";

describe("twilio signature", () => {
  // Worked example from Twilio's docs (https://www.twilio.com/docs/usage/webhooks/webhooks-security).
  const token = "12345";
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };

  it("matches Twilio's published example", () => {
    expect(twilioSignature(token, url, params)).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  });
  it("accepts a valid signature and rejects tampering", () => {
    const sig = twilioSignature(token, url, params);
    expect(validateTwilioSignature(token, url, params, sig)).toBe(true);
    expect(validateTwilioSignature(token, url, { ...params, Digits: "9999" }, sig)).toBe(false);
    expect(validateTwilioSignature("other", url, params, sig)).toBe(false);
    expect(validateTwilioSignature(token, url + "x", params, sig)).toBe(false);
    expect(validateTwilioSignature(token, url, params, undefined)).toBe(false);
    expect(validateTwilioSignature(token, url, params, "short")).toBe(false);
  });
});

describe("phone normalisation", () => {
  it("turns US formats into E.164 and leaves E.164 alone", () => {
    expect(normalizePhone("(713) 555-0187")).toBe("+17135550187");
    expect(normalizePhone("713.555.0187")).toBe("+17135550187");
    expect(normalizePhone("1 713 555 0187")).toBe("+17135550187");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
  it("escapes XML for TwiML", () => {
    expect(escapeXml(`Tom & "Jerry" <call>`)).toBe("Tom &amp; &quot;Jerry&quot; &lt;call&gt;");
  });
});
