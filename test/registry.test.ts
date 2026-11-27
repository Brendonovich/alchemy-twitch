import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { buildCondition, decodeEvent, subscriptions } from "../src/eventsub/registry.ts";

const broadcaster = {
  broadcaster_user_id: "100",
  broadcaster_user_login: "streamer",
  broadcaster_user_name: "Streamer",
};

describe("EventSub registry", () => {
  it("carries Twitch's version and scopes per type", () => {
    expect(subscriptions["channel.follow"].version).toBe("2");
    expect(subscriptions["channel.chat.message"].scopes).toEqual([
      "user:read:chat",
      "user:bot",
      "channel:bot",
    ]);
    expect(subscriptions["stream.online"].scopes).toEqual([]);
  });

  it.effect("decodes a chat message", () =>
    Effect.gen(function* () {
      const event = yield* decodeEvent("channel.chat.message", {
        ...broadcaster,
        chatter_user_id: "300",
        chatter_user_login: "viewer",
        chatter_user_name: "Viewer",
        message_id: "m-1",
        message: { text: "hi", fragments: [{ type: "text", text: "hi" }] },
        color: "#FF0000",
        badges: [],
        message_type: "text",
      });
      expect(event.type).toBe("channel.chat.message");
      expect(event.version).toBe("1");
      if (event.type === "channel.chat.message") {
        expect(event.payload.message.text).toBe("hi");
      }
    }),
  );

  it.effect("decodes timestamps to Dates", () =>
    Effect.gen(function* () {
      const event = yield* decodeEvent("stream.online", {
        ...broadcaster,
        id: "s-1",
        type: "live",
        started_at: "2026-11-27T12:00:00Z",
      });
      if (event.type !== "stream.online") return yield* Effect.die("wrong type");
      expect(event.payload.started_at).toBeInstanceOf(Date);
    }),
  );

  it.effect("decodes the authorization and conduit events", () =>
    Effect.gen(function* () {
      const revoke = yield* decodeEvent("user.authorization.revoke", {
        client_id: "app",
        user_id: "300",
        user_login: null,
        user_name: null,
      });
      expect(revoke.type).toBe("user.authorization.revoke");
      const grant = yield* decodeEvent("user.authorization.grant", {
        client_id: "app",
        user_id: "300",
        user_login: "viewer",
        user_name: "Viewer",
      });
      expect(grant.type).toBe("user.authorization.grant");
      const disabled = yield* decodeEvent("conduit.shard.disabled", {
        conduit_id: "c-1",
        shard_id: "0",
        status: "webhook_callback_verification_failed",
        transport: { method: "webhook", callback: "https://bot.example/hook" },
      });
      expect(disabled).toMatchObject({ type: "conduit.shard.disabled", payload: { shard_id: "0" } });
    }),
  );

  it.effect("fails on unknown types and invalid payloads", () =>
    Effect.gen(function* () {
      const unknown = yield* Effect.flip(decodeEvent("channel.unknown", {}));
      expect(unknown._tag).toBe("UnknownSubscriptionType");
      const invalid = yield* Effect.flip(decodeEvent("channel.raid", { viewers: "many" }));
      expect(invalid._tag).toBe("SchemaError");
    }),
  );

  it("builds flat conditions, dropping unset optionals and enforcing raid's either/or", () => {
    expect(
      buildCondition("channel.channel_points_custom_reward_redemption.add", {
        broadcaster_user_id: "100",
      }),
    ).toEqual({ broadcaster_user_id: "100" });
    expect(buildCondition("channel.raid", { to_broadcaster_user_id: "100" })).toEqual({
      to_broadcaster_user_id: "100",
    });
    expect(() => buildCondition("channel.raid", {})).toThrow();
  });
});
