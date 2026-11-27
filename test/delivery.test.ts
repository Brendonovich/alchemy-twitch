import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { handleDelivery, type Notification } from "../src/eventsub/EventSource.ts";
import { computeSignature } from "../src/eventsub/webhook.ts";

const secret = "a-webhook-secret-of-sufficient-length";
const timestamp = "2026-11-27T12:00:00.000Z";
const now = Date.parse(timestamp);

const subscription = (type: string, version: string) => ({
  id: "sub-1",
  status: "enabled",
  type,
  version,
  condition: { broadcaster_user_id: "100", moderator_user_id: "200" },
  created_at: "2026-11-27T11:00:00.000Z",
  transport: { method: "conduit", conduit_id: "conduit-1" },
  cost: 0,
});

const followEvent = {
  user_id: "300",
  user_login: "viewer",
  user_name: "Viewer",
  broadcaster_user_id: "100",
  broadcaster_user_login: "streamer",
  broadcaster_user_name: "Streamer",
  followed_at: "2026-11-27T11:59:00.000Z",
};

const envelope = (messageType: string, payload: unknown) =>
  JSON.stringify({
    metadata: {
      message_id: "msg-1",
      message_type: messageType,
      message_timestamp: timestamp,
    },
    payload,
  });

const signedRequest = (
  messageType: string,
  body: string,
  options: { readonly timestamp?: string; readonly secret?: string; readonly method?: string } = {},
) =>
  Effect.gen(function* () {
    const sentAt = options.timestamp ?? timestamp;
    const signature = yield* computeSignature({
      secret: options.secret ?? secret,
      messageId: "msg-1",
      timestamp: sentAt,
      body,
    });
    return new Request("https://bot.example.workers.dev/twitch/eventsub/BotConduit", {
      method: options.method ?? "POST",
      headers: {
        "Twitch-Eventsub-Message-Id": "msg-1",
        "Twitch-Eventsub-Message-Timestamp": sentAt,
        "Twitch-Eventsub-Message-Signature": signature,
        "Twitch-Eventsub-Message-Type": messageType,
        "content-type": "application/json",
      },
      ...(options.method === "GET" ? {} : { body }),
    });
  });

const types = ["channel.follow"] as const;

const deliver = (
  request: Request,
  handler: (event: Notification<"channel.follow">) => Effect.Effect<void, string> = () =>
    Effect.void,
) =>
  handleDelivery({
    request,
    secret: Effect.succeed(Redacted.make(secret)),
    types,
    handler,
    now,
  });

describe("EventSub conduit deliveries", () => {
  it.effect("answers the callback challenge with the raw challenge as text/plain", () =>
    Effect.gen(function* () {
      const request = yield* signedRequest(
        "webhook_callback_verification",
        envelope("webhook_callback_verification", {
          subscription: subscription("channel.follow", "2"),
          challenge: "pogchamp-kappa-360noscope",
        }),
      );
      const response = yield* deliver(request);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain");
      expect(yield* Effect.promise(() => response.text())).toBe("pogchamp-kappa-360noscope");
    }),
  );

  it.effect("rejects a bad signature", () =>
    Effect.gen(function* () {
      const request = yield* signedRequest(
        "notification",
        envelope("notification", { subscription: subscription("channel.follow", "2"), event: followEvent }),
        { secret: "a-different-secret-entirely-0000" },
      );
      let called = false;
      const response = yield* deliver(request, () => Effect.sync(() => void (called = true)));
      expect(response.status).toBe(403);
      expect(called).toBe(false);
    }),
  );

  it.effect("rejects deliveries older than ten minutes", () =>
    Effect.gen(function* () {
      const request = yield* signedRequest(
        "notification",
        envelope("notification", { subscription: subscription("channel.follow", "2"), event: followEvent }),
        { timestamp: new Date(now - 10 * 60 * 1000 - 1).toISOString() },
      );
      const response = yield* deliver(request);
      expect(response.status).toBe(403);
    }),
  );

  it.effect("rejects non-POST requests", () =>
    Effect.gen(function* () {
      const request = yield* signedRequest("notification", "", { method: "GET" });
      const response = yield* deliver(request);
      expect(response.status).toBe(405);
    }),
  );

  it.effect("acknowledges revocations without running the handler", () =>
    Effect.gen(function* () {
      const request = yield* signedRequest(
        "revocation",
        envelope("revocation", {
          subscription: { ...subscription("channel.follow", "2"), status: "authorization_revoked" },
        }),
      );
      let called = false;
      const response = yield* deliver(request, () => Effect.sync(() => void (called = true)));
      expect(response.status).toBe(204);
      expect(called).toBe(false);
    }),
  );

  it.effect("decodes listed notifications and dispatches them to the handler", () =>
    Effect.gen(function* () {
      const request = yield* signedRequest(
        "notification",
        envelope("notification", { subscription: subscription("channel.follow", "2"), event: followEvent }),
      );
      const received: Array<Notification<"channel.follow">> = [];
      const response = yield* deliver(request, (event) => Effect.sync(() => void received.push(event)));
      expect(response.status).toBe(204);
      expect(received).toHaveLength(1);
      const [event] = received;
      expect(event?.type).toBe("channel.follow");
      expect(event?.payload.user_login).toBe("viewer");
      expect(event?.payload.followed_at).toBeInstanceOf(Date);
      expect(event?.messageId).toBe("msg-1");
      expect(event?.subscription.id).toBe("sub-1");
    }),
  );

  it.effect("ignores notifications for unlisted types", () =>
    Effect.gen(function* () {
      const request = yield* signedRequest(
        "notification",
        envelope("notification", {
          subscription: subscription("stream.online", "1"),
          event: {
            id: "stream-1",
            broadcaster_user_id: "100",
            broadcaster_user_login: "streamer",
            broadcaster_user_name: "Streamer",
            type: "live",
            started_at: timestamp,
          },
        }),
      );
      let called = false;
      const response = yield* deliver(request, () => Effect.sync(() => void (called = true)));
      expect(response.status).toBe(204);
      expect(called).toBe(false);
    }),
  );

  it.effect("returns a non-2xx status when the handler fails", () =>
    Effect.gen(function* () {
      const request = yield* signedRequest(
        "notification",
        envelope("notification", { subscription: subscription("channel.follow", "2"), event: followEvent }),
      );
      const response = yield* deliver(request, () => Effect.fail("boom"));
      expect(response.status).toBe(500);
    }),
  );

  it.effect("fails closed when the secret is missing", () =>
    Effect.gen(function* () {
      const request = yield* signedRequest("notification", "{}");
      const response = yield* handleDelivery({
        request,
        secret: Effect.succeed(undefined),
        types,
        handler: () => Effect.void,
        now,
      });
      expect(response.status).toBe(500);
    }),
  );
});
