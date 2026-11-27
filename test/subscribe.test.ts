import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeConsumer } from "../src/eventsub/EventSourceLive.ts";
import { makeFakeHelix } from "./fake-helix.ts";

const consumerFor = (helix: ReturnType<typeof makeFakeHelix>, conduitId: string | undefined) =>
  makeConsumer<"channel.chat.message" | "channel.follow">({
    app: helix.app,
    conduit: "BotConduit",
    path: "/twitch/eventsub/BotConduit",
    types: ["channel.chat.message", "channel.follow"],
    conduitId: Effect.succeed(conduitId),
  });

describe("EventSub consumer subscribe", () => {
  it.effect("creates a conduit subscription with the registry version and typed condition", () =>
    Effect.gen(function* () {
      const helix = makeFakeHelix();
      const consumer = consumerFor(helix, "conduit-9");
      const created = yield* consumer.subscribe("channel.follow", {
        broadcaster_user_id: "100",
        moderator_user_id: "200",
      });
      expect(created.created).toBe(true);
      expect(created.id).toBeDefined();
      expect(helix.calls[0]).toEqual({
        method: "POST",
        path: "/eventsub/subscriptions",
        body: {
          type: "channel.follow",
          version: "2",
          condition: { broadcaster_user_id: "100", moderator_user_id: "200" },
          transport: { method: "conduit", conduit_id: "conduit-9" },
        },
      });
    }),
  );

  it.effect("treats 409 as success and adopts the existing subscription id", () =>
    Effect.gen(function* () {
      const helix = makeFakeHelix();
      const consumer = consumerFor(helix, "conduit-9");
      const condition = { broadcaster_user_id: "100", user_id: "200" };
      const first = yield* consumer.subscribe("channel.chat.message", condition);
      const second = yield* consumer.subscribe("channel.chat.message", condition);
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
      expect(helix.subscriptions).toHaveLength(1);
    }),
  );

  it.effect("treats 409 as success even when the duplicate can't be listed", () =>
    Effect.gen(function* () {
      const helix = makeFakeHelix();
      const consumer = consumerFor(helix, "conduit-9");
      const condition = { broadcaster_user_id: "100", user_id: "200" };
      yield* consumer.subscribe("channel.chat.message", condition);
      // Twitch sometimes lags listing a subscription it already rejects as a duplicate.
      const listed = helix.subscriptions[0];
      if (listed !== undefined) listed.type = "hidden";
      const original = helix.app.helix;
      const app = {
        helix: (call: Parameters<typeof original>[0]) =>
          call.method === "POST"
            ? Effect.succeed({ status: 409, body: { message: "subscription already exists" } })
            : original(call),
      };
      const result = yield* makeConsumer<"channel.chat.message">({
        app,
        conduit: "BotConduit",
        path: "/p",
        types: ["channel.chat.message"],
        conduitId: Effect.succeed("conduit-9"),
      }).subscribe("channel.chat.message", condition);
      expect(result).toEqual({ id: undefined, status: "enabled", created: false });
    }),
  );

  it.effect("fails with ConduitUnavailable before the conduit is deployed", () =>
    Effect.gen(function* () {
      const helix = makeFakeHelix();
      const error = yield* Effect.flip(
        consumerFor(helix, undefined).subscribe("channel.follow", {
          broadcaster_user_id: "100",
          moderator_user_id: "200",
        }),
      );
      expect(error._tag).toBe("ConduitUnavailable");
      expect(helix.calls).toHaveLength(0);
    }),
  );

  it.effect("surfaces other Helix failures", () =>
    Effect.gen(function* () {
      const app = {
        helix: () => Effect.succeed({ status: 403, body: { message: "missing channel:bot" } }),
      };
      const error = yield* Effect.flip(
        makeConsumer<"channel.follow">({
          app,
          conduit: "BotConduit",
          path: "/p",
          types: ["channel.follow"],
          conduitId: Effect.succeed("conduit-9"),
        }).subscribe("channel.follow", { broadcaster_user_id: "1", moderator_user_id: "2" }),
      );
      expect(error._tag).toBe("TwitchAppError");
      expect(error.message).toBe("missing channel:bot");
    }),
  );

  it("exposes the scopes its types need", () => {
    expect(consumerFor(makeFakeHelix(), "conduit-9").scopes).toEqual([
      "moderator:read:followers",
      "user:read:chat",
    ]);
  });

  it.effect("unsubscribes idempotently", () =>
    Effect.gen(function* () {
      const helix = makeFakeHelix();
      const consumer = consumerFor(helix, "conduit-9");
      const created = yield* consumer.subscribe("channel.follow", {
        broadcaster_user_id: "100",
        moderator_user_id: "200",
      });
      yield* consumer.unsubscribe(created.id ?? "");
      yield* consumer.unsubscribe(created.id ?? "");
      expect(helix.subscriptions).toHaveLength(0);
    }),
  );
});
