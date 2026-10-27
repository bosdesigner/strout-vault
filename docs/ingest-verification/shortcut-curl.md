# Shortcut requests with curl, against a local vault

Run on 2026-10-27 against `npm run dev` (local Postgres, `STORAGE_DRIVER=local`, so the part URL points at the
vault's local-driver twin of a presigned R2 URL). Token and URL signature redacted.
Nothing reached R2 or Neon.

```
file: call.m4a, 36393 bytes, sha256 59a59e26b8a2f311b0af2c65888f8bb8c3e7f48395156b956e8f27e246374987

$ curl -s -X POST $VAULT/api/ingest/device/presign -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"source":"iphone_call","source_ref":"shortcut:59a59e26b8a2f311b0af2c65888f8bb8c3e7f48395156b956e8f27e246374987","sha256":"59a59e26b8a2f311b0af2c65888f8bb8c3e7f48395156b956e8f27e246374987","bytes":36393,"content_type":"audio/mp4","filename":"call.m4a","single_part":true}'
{
  "duplicate": false,
  "key": "uploads/device/2026/10/7c8276eb-85e0-41c6-8f8c-134c3367844f/call.m4a",
  "upload_id": "c62df8739c9150c9f5f164bbef5c9b03",
  "part_size": 36393,
  "parts": [
    {
      "part_number": 1,
      "url": "http://localhost:3000/api/ingest/device/local/part?uploadId=c62df8739c9150c9f5f164bbef5c9b03&key=uploads%2Fdevice%2F2026%2F10%2F7c8276eb-85e0-41c6-8f8c-134c3367844f%2Fcall.m4a&partNumber=1&exp=1793081204&sig=…",
      "method": "PUT",
      "headers": {}
    }
  ],
  "expires_at": "2026-10-27T06:06:44.000Z"
}

$ curl -s -o /dev/null -w '%{http_code}\n' -X PUT --data-binary @call.m4a "<parts[0].url>"
200

$ curl -s -X POST $VAULT/api/ingest/device/finalize -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"source":"iphone_call","source_ref":"shortcut:59a59e26b8a2f311b0af2c65888f8bb8c3e7f48395156b956e8f27e246374987","sha256":"59a59e26b8a2f311b0af2c65888f8bb8c3e7f48395156b956e8f27e246374987","bytes":36393,"key":"uploads/device/2026/10/7c8276eb-85e0-41c6-8f8c-134c3367844f/call.m4a","upload_id":"c62df8739c9150c9f5f164bbef5c9b03","content_type":"audio/mp4","filename":"call.m4a","occurred_at":"2026-10-27T09:15:00-05:00","title":"Call with Kevin McGuire","participants_raw":[{"name":"Kevin McGuire"}]}'
{"duplicate":false,"interaction_id":86,"media_id":130,"workspace_id":"another_story","review_queued":false}
HTTP 201

$ # the same file again: presign answers duplicate, nothing is uploaded
{"duplicate":true,"interaction_id":86}
HTTP 200

$ # no token / wrong token
{"error":"unauthenticated"}  HTTP 401
{"error":"invalid_token"}  HTTP 401
```

The finalized call was matched to Kevin McGuire by name and filed under `another_story` (his only workspace).
