import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { TwitchApp } from "../src/app.ts";
import { Conduit, ConduitProvider, type ConduitProps } from "../src/eventsub/Conduit.ts";
import {
  ConduitShard,
  ConduitShardProvider,
  type ConduitShardAttributes,
  type ConduitShardProps,
} from "../src/eventsub/ConduitShard.ts";
import { makeFakeHelix } from "./fake-helix.ts";

// Older Alchemy betas also require `emit`/`done` on the session.
const noopSession = { note: () => Effect.void, emit: () => Effect.void, done: () => Effect.void };

const base = { id: "BotConduit", fqn: "BotConduit", instanceId: "i-1", bindings: [] };

const conduitProvider = (helix: ReturnType<typeof makeFakeHelix>) =>
  Effect.gen(function* () {
    return yield* Conduit.Provider;
  }).pipe(
    Effect.provide(ConduitProvider().pipe(Layer.provide(Layer.succeed(TwitchApp, helix.app)))),
  );

const shardProvider = (helix: ReturnType<typeof makeFakeHelix>) =>
  Effect.gen(function* () {
    return yield* ConduitShard.Provider;
  }).pipe(
    Effect.provide(
      ConduitShardProvider({ wait: { attempts: 3, interval: 0 } }).pipe(
        Layer.provide(Layer.succeed(TwitchApp, helix.app)),
      ),
    ),
  );

const reconcileConduit = (
  helix: ReturnType<typeof makeFakeHelix>,
  news: ConduitProps,
  previous?: { olds: ConduitProps; output: Conduit["Attributes"] },
) =>
  Effect.gen(function* () {
    const provider = yield* conduitProvider(helix);
    return yield* provider.reconcile({
      ...base,
      news,
      olds: previous?.olds,
      output: previous?.output,
      session: noopSession,
    });
  });

describe("Conduit provider", () => {
  it.effect("creates a conduit and leaves an unchanged one alone", () =>
    Effect.gen(function* () {
      const helix = makeFakeHelix();
      const created = yield* reconcileConduit(helix, {});
      expect(created).toEqual({ conduitId: "conduit-1", shardCount: 1, adopted: false });

      const again = yield* reconcileConduit(helix, {}, { olds: {}, output: created });
      expect(again).toEqual(created);
      expect(helix.conduits.size).toBe(1);
      expect(helix.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
    }),
  );

  it.effect("updates the shard count in place", () =>
    Effect.gen(function* () {
      const helix = makeFakeHelix();
      const created = yield* reconcileConduit(helix, {});
      const updated = yield* reconcileConduit(helix, { shardCount: 3 }, { olds: {}, output: created });
      expect(updated).toEqual({ conduitId: created.conduitId, shardCount: 3, adopted: false });
      expect(helix.conduits.get(created.conduitId)?.shards).toHaveLength(3);
    }),
  );

  it.effect("recreates a conduit that disappeared", () =>
    Effect.gen(function* () {
      const helix = makeFakeHelix();
      const created = yield* reconcileConduit(helix, {});
      helix.conduits.clear();
      const recreated = yield* reconcileConduit(helix, {}, { olds: {}, output: created });
      expect(recreated.conduitId).not.toBe(created.conduitId);
    }),
  );

  it.effect("adopts an existing conduit by id and never deletes it", () =>
    Effect.gen(function* () {
      const helix = makeFakeHelix();
      const existing = yield* reconcileConduit(helix, {});
      const adopted = yield* reconcileConduit(helix, { adopt: { conduitId: existing.conduitId } });
      expect(adopted).toEqual({ conduitId: existing.conduitId, shardCount: 1, adopted: true });

      const provider = yield* conduitProvider(helix);
      yield* provider.delete({
        ...base,
        olds: { adopt: { conduitId: existing.conduitId } },
        output: adopted,
        session: noopSession,
      });
      expect(helix.conduits.has(existing.conduitId)).toBe(true);
    }),
  );

  it.effect("fails to adopt a conduit that doesn't exist", () =>
    Effect.gen(function* () {
      const helix = makeFakeHelix();
      const error = yield* Effect.flip(
        reconcileConduit(helix, { adopt: { conduitId: "missing" } }),
      );
      expect(error._tag).toBe("TwitchAppError");
      expect(helix.conduits.size).toBe(0);
    }),
  );

  it.effect("deletes owned conduits idempotently", () =>
    Effect.gen(function* () {
      const helix = makeFakeHelix();
      const created = yield* reconcileConduit(helix, {});
      const provider = yield* conduitProvider(helix);
      const input = { ...base, olds: {}, output: created, session: noopSession };
      yield* provider.delete(input);
      yield* provider.delete(input);
      expect(helix.conduits.size).toBe(0);
    }),
  );

  it.effect("reads the conduit back, or nothing once it's gone", () =>
    Effect.gen(function* () {
      const helix = makeFakeHelix();
      const created = yield* reconcileConduit(helix, {});
      const provider = yield* conduitProvider(helix);
      const read = provider.read;
      if (read === undefined) return yield* Effect.die("read missing");
      expect(yield* read({ ...base, olds: {}, output: created })).toEqual(created);
      helix.conduits.clear();
      expect(yield* read({ ...base, olds: {}, output: created })).toBeUndefined();
    }),
  );

  it.effect("replaces when the adopted conduit changes", () =>
    Effect.gen(function* () {
      const helix = makeFakeHelix();
      const provider = yield* conduitProvider(helix);
      const diff = provider.diff;
      if (diff === undefined) return yield* Effect.die("diff missing");
      const input = {
        ...base,
        oldBindings: [],
        newBindings: [],
        output: undefined,
      };
      expect(
        yield* diff({ ...input, olds: { adopt: { conduitId: "a" } }, news: { adopt: { conduitId: "b" } } }),
      ).toEqual({ action: "replace" });
      expect(yield* diff({ ...input, olds: {}, news: { shardCount: 2 } })).toBeUndefined();
    }),
  );
});

describe("ConduitShard provider", () => {
  const props = (conduitId: string, callback = "https://bot.example/twitch/eventsub/BotConduit") =>
    ({
      conduitId,
      callback,
      secret: Redacted.make("a-webhook-secret-of-sufficient-length"),
    }) satisfies ConduitShardProps;

  const reconcileShard = (
    helix: ReturnType<typeof makeFakeHelix>,
    news: ConduitShardProps,
    previous?: { olds: ConduitShardProps; output: ConduitShardAttributes },
  ) =>
    Effect.gen(function* () {
      const provider = yield* shardProvider(helix);
      return yield* provider.reconcile({
        ...base,
        id: "BotConduitShard",
        news,
        olds: previous?.olds,
        output: previous?.output,
        session: noopSession,
      });
    });

  it.effect("points shard 0 at the callback and waits for verification", () =>
    Effect.gen(function* () {
      const helix = makeFakeHelix();
      const conduit = yield* reconcileConduit(helix, {});
      const shard = yield* reconcileShard(helix, props(conduit.conduitId));
      expect(shard).toEqual({
        conduitId: conduit.conduitId,
        shardId: "0",
        callback: "https://bot.example/twitch/eventsub/BotConduit",
        status: "enabled",
      });
      const patch = helix.calls.find(
        (call) => call.method === "PATCH" && call.path === "/eventsub/conduits/shards",
      );
      expect(patch?.body).toEqual({
        conduit_id: conduit.conduitId,
        shards: [
          {
            id: "0",
            transport: {
              method: "webhook",
              callback: "https://bot.example/twitch/eventsub/BotConduit",
              secret: "a-webhook-secret-of-sufficient-length",
            },
          },
        ],
      });
    }),
  );

  it.effect("skips the update when nothing changed and the shard is enabled", () =>
    Effect.gen(function* () {
      const helix = makeFakeHelix();
      const conduit = yield* reconcileConduit(helix, {});
      const news = props(conduit.conduitId);
      const output = yield* reconcileShard(helix, news);
      const patchesBefore = helix.calls.filter((call) => call.method === "PATCH").length;
      yield* reconcileShard(helix, news, { olds: news, output });
      expect(helix.calls.filter((call) => call.method === "PATCH").length).toBe(patchesBefore);

      yield* reconcileShard(helix, props(conduit.conduitId, "https://new.example/hook"), {
        olds: news,
        output,
      });
      expect(helix.calls.filter((call) => call.method === "PATCH").length).toBe(patchesBefore + 1);
    }),
  );

  it.effect("fails when Twitch can't verify the callback", () =>
    Effect.gen(function* () {
      const helix = makeFakeHelix({ shardStatusAfterPatch: () => "webhook_callback_verification_failed" });
      const conduit = yield* reconcileConduit(helix, {});
      const error = yield* Effect.flip(reconcileShard(helix, props(conduit.conduitId)));
      expect(error._tag).toBe("TwitchAppError");
      expect(error.message).toContain("could not verify");
    }),
  );

  it.effect("returns a pending shard after the wait instead of failing", () =>
    Effect.gen(function* () {
      const helix = makeFakeHelix({
        shardStatusAfterPatch: () => "webhook_callback_verification_pending",
      });
      const conduit = yield* reconcileConduit(helix, {});
      const shard = yield* reconcileShard(helix, props(conduit.conduitId));
      expect(shard.status).toBe("webhook_callback_verification_pending");
    }),
  );

  it.effect("fails on per-shard errors from Twitch", () =>
    Effect.gen(function* () {
      const helix = makeFakeHelix({
        shardErrors: [{ id: "0", message: "callback must use https", code: "invalid_parameter" }],
      });
      const conduit = yield* reconcileConduit(helix, {});
      const error = yield* Effect.flip(reconcileShard(helix, props(conduit.conduitId)));
      expect(error.message).toContain("callback must use https");
    }),
  );

  it.effect("deleting a shard leaves the conduit untouched", () =>
    Effect.gen(function* () {
      const helix = makeFakeHelix();
      const conduit = yield* reconcileConduit(helix, {});
      const news = props(conduit.conduitId);
      const output = yield* reconcileShard(helix, news);
      const callsBefore = helix.calls.length;
      const provider = yield* shardProvider(helix);
      yield* provider.delete({ ...base, olds: news, output, session: noopSession });
      expect(helix.calls.length).toBe(callsBefore);
    }),
  );
});
