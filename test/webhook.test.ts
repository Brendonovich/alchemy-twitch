import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { computeSignature, decodeWebhook, verifyWebhook } from "../src/eventsub/webhook.ts";

// Same vector as Twitch's documented scheme: HMAC-SHA256(secret, id + timestamp + body).
const secret = "s3cret";
const body = '{"challenge":"abc"}';
const messageId = "msg-1";
const timestamp = "2026-11-22T00:00:00.000Z";
const now = Date.parse(timestamp);
const knownSignature = "sha256=6ba0cb9f97d26d1f9f3086287d00484e3ed84c6834ac2a433f1020cdb65b8a1f";

const headers = (signature = knownSignature) => ({
  "Twitch-Eventsub-Message-Id": messageId,
  "Twitch-Eventsub-Message-Timestamp": timestamp,
  "Twitch-Eventsub-Message-Signature": signature,
});

describe("EventSub webhook signatures", () => {
  it.effect("computes Twitch's HMAC-SHA256 signature", () =>
    Effect.gen(function* () {
      expect(yield* computeSignature({ secret, messageId, timestamp, body })).toBe(knownSignature);
    }),
  );

  it.effect("accepts a signed message inside the window, over string or raw bytes", () =>
    Effect.gen(function* () {
      yield* verifyWebhook({ headers: headers(), body, secret, now });
      yield* verifyWebhook({
        headers: headers(),
        body: new TextEncoder().encode(body),
        secret,
        now,
      });
    }),
  );

  it.effect("rejects stale and future timestamps", () =>
    Effect.gen(function* () {
      const late = yield* Effect.flip(
        verifyWebhook({ headers: headers(), body, secret, now: now + 10 * 60 * 1000 + 1 }),
      );
      expect(late.code).toBe("timestamp-out-of-window");
      const early = yield* Effect.flip(
        verifyWebhook({ headers: headers(), body, secret, now: now - 10 * 60 * 1000 - 1 }),
      );
      expect(early.code).toBe("timestamp-out-of-window");
    }),
  );

  it.effect("rejects a tampered body, a wrong secret and a malformed signature", () =>
    Effect.gen(function* () {
      const tampered = yield* Effect.flip(
        verifyWebhook({ headers: headers(), body: '{"challenge":"abd"}', secret, now }),
      );
      expect(tampered.code).toBe("invalid-signature");
      const wrongSecret = yield* Effect.flip(
        verifyWebhook({ headers: headers(), body, secret: "other", now }),
      );
      expect(wrongSecret.code).toBe("invalid-signature");
      const malformed = yield* Effect.flip(
        verifyWebhook({ headers: headers("md5=zz"), body, secret, now }),
      );
      expect(malformed.code).toBe("invalid-signature");
    }),
  );

  it.effect("rejects missing headers and unparseable timestamps", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.flip(
        verifyWebhook({
          headers: { "Twitch-Eventsub-Message-Id": messageId },
          body,
          secret,
          now,
        }),
      );
      expect(missing.code).toBe("missing-header");
      const invalid = yield* Effect.flip(
        verifyWebhook({
          headers: { ...headers(), "Twitch-Eventsub-Message-Timestamp": "yesterday" },
          body,
          secret,
          now,
        }),
      );
      expect(invalid.code).toBe("invalid-timestamp");
    }),
  );
});

describe("EventSub webhook envelopes", () => {
  const subscription = {
    id: "sub-1",
    status: "enabled",
    type: "stream.online",
    version: "1",
    condition: { broadcaster_user_id: "100" },
    transport: { method: "conduit", conduit_id: "c-1" },
    created_at: timestamp,
    cost: 0,
  };
  const signed = (payload: string) =>
    Effect.map(computeSignature({ secret, messageId, timestamp, body: payload }), (signature) => ({
      headers: headers(signature),
      body: payload,
      secret,
      now,
    }));
  const envelope = (type: string, payload: unknown) =>
    JSON.stringify({
      metadata: { message_id: messageId, message_type: type, message_timestamp: timestamp },
      payload,
    });

  it.effect("decodes verification, notification and revocation messages", () =>
    Effect.gen(function* () {
      const verification = yield* decodeWebhook(
        yield* signed(envelope("webhook_callback_verification", { subscription, challenge: "c" })),
      );
      expect(verification).toMatchObject({ _tag: "verification", challenge: "c" });

      const notification = yield* decodeWebhook(
        yield* signed(envelope("notification", { subscription, event: { a: 1 } })),
      );
      expect(notification).toMatchObject({
        _tag: "notification",
        messageId,
        event: { a: 1 },
        subscription: { id: "sub-1", type: "stream.online" },
      });

      const revocation = yield* decodeWebhook(
        yield* signed(envelope("revocation", { subscription: { ...subscription, status: "user_removed" } })),
      );
      expect(revocation).toMatchObject({ _tag: "revocation", subscription: { status: "user_removed" } });
    }),
  );

  it.effect("rejects a verified body that isn't an envelope", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeWebhook(yield* signed('{"hello":"world"}')));
      expect(error._tag).toBe("WebhookPayloadError");
    }),
  );

  it.effect("decodes Twitch webhook and conduit bodies whose metadata is in headers", () =>
    Effect.gen(function* () {
      const webhookBody = (type: string, payload: object) =>
        JSON.stringify({ subscription, ...payload });
      const signedWebhook = (type: string, payload: string) =>
        Effect.map(computeSignature({ secret, messageId, timestamp, body: payload }), (signature) => ({
          headers: { ...headers(signature), "Twitch-Eventsub-Message-Type": type },
          body: payload,
          secret,
          now,
        }));

      const notification = yield* decodeWebhook(
        yield* signedWebhook("notification", webhookBody("notification", { event: { a: 1 } })),
      );
      expect(notification).toMatchObject({
        _tag: "notification",
        messageId,
        messageTimestamp: new Date(timestamp),
        event: { a: 1 },
        subscription: { id: "sub-1", type: "stream.online" },
      });

      const verification = yield* decodeWebhook(
        yield* signedWebhook("webhook_callback_verification", webhookBody("verification", { challenge: "c" })),
      );
      expect(verification).toMatchObject({ _tag: "verification", challenge: "c" });

      const revocation = yield* decodeWebhook(
        yield* signedWebhook("revocation", webhookBody("revocation", {})),
      );
      expect(revocation).toMatchObject({ _tag: "revocation", subscription: { id: "sub-1" } });
    }),
  );
});
