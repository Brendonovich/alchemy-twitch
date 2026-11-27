import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { TwitchApp, TwitchAppError, type TwitchAppService } from "../app.ts";
import { findShard, updateShard, type HelixShard } from "./helix.ts";

export interface ConduitShardProps {
  conduitId: string;
  /** @default "0" */
  shardId?: string;
  /** Public HTTPS URL that Twitch delivers to. */
  callback: string;
  /** HMAC secret Twitch signs deliveries with (10-100 characters). */
  secret: Redacted.Redacted<string>;
  /**
   * Wait for Twitch to verify the callback. Fails the deploy when
   * verification fails; a shard still pending after the wait only warns.
   * @default true
   */
  waitForEnabled?: boolean;
}

export interface ConduitShardAttributes {
  conduitId: string;
  shardId: string;
  callback: string;
  /** Twitch shard status, e.g. `enabled` or `webhook_callback_verification_pending`. */
  status: string;
}

/**
 * One webhook shard of a {@link Conduit}. Twitch creates shards with the
 * conduit, so this only points a shard at a callback; deleting it is a
 * no-op because the conduit owns the shard's lifetime.
 */
export type ConduitShard = Resource<
  "Twitch.EventSub.ConduitShard",
  ConduitShardProps,
  ConduitShardAttributes
>;

export const ConduitShard = Resource<ConduitShard>("Twitch.EventSub.ConduitShard");

const DEFAULT_SHARD_ID = "0";
const VERIFICATION_FAILED = "webhook_callback_verification_failed";

const toAttributes = (
  conduitId: string,
  shardId: string,
  callback: string,
  status: string,
): ConduitShardAttributes => ({ conduitId, shardId, callback, status });

export interface ShardWaitOptions {
  readonly attempts: number;
  readonly interval: Duration.Input;
}

const DEFAULT_WAIT: ShardWaitOptions = { attempts: 15, interval: "1 second" };

/** Poll until the shard leaves verification; fail if Twitch rejected the callback. */
const waitForShard = (
  app: TwitchAppService,
  conduitId: string,
  shardId: string,
  wait: ShardWaitOptions,
): Effect.Effect<HelixShard | undefined, TwitchAppError> =>
  Effect.gen(function* () {
    let shard: HelixShard | undefined;
    for (let attempt = 0; attempt < wait.attempts; attempt += 1) {
      shard = yield* findShard(app, conduitId, shardId);
      if (shard?.status === "enabled") return shard;
      if (shard?.status === VERIFICATION_FAILED) {
        return yield* new TwitchAppError({
          operation: "verifyConduitShard",
          status: 0,
          message: `Twitch could not verify the callback for shard ${shardId} of conduit ${conduitId}. Is the Worker deployed and answering the challenge?`,
        });
      }
      if (attempt + 1 < wait.attempts) yield* Effect.sleep(wait.interval);
    }
    return shard;
  });

export const ConduitShardProvider = (options: { readonly wait?: ShardWaitOptions } = {}) =>
  Provider.effect(
    ConduitShard,
    Effect.gen(function* () {
      const app = yield* TwitchApp;
      const wait = options.wait ?? DEFAULT_WAIT;
      return {
        stables: ["shardId"],

        read: ({ olds, output }) =>
          Effect.gen(function* () {
            if (output === undefined) return undefined;
            const shard = yield* findShard(app, output.conduitId, output.shardId);
            if (shard === undefined) return undefined;
            return toAttributes(
              output.conduitId,
              output.shardId,
              shard.transport.callback ?? olds.callback,
              shard.status,
            );
          }),

        reconcile: ({ news, olds, output, session }) =>
          Effect.gen(function* () {
            const shardId = news.shardId ?? DEFAULT_SHARD_ID;
            const observed = yield* findShard(app, news.conduitId, shardId);
            const unchanged =
              olds !== undefined &&
              output !== undefined &&
              olds.conduitId === news.conduitId &&
              (olds.shardId ?? DEFAULT_SHARD_ID) === shardId &&
              olds.callback === news.callback &&
              Redacted.value(olds.secret) === Redacted.value(news.secret) &&
              observed?.status === "enabled" &&
              observed.transport.method === "webhook" &&
              observed.transport.callback === news.callback;
            if (unchanged) {
              return toAttributes(news.conduitId, shardId, news.callback, observed.status);
            }

            const updated = yield* updateShard(app, {
              conduitId: news.conduitId,
              shardId,
              callback: news.callback,
              secret: Redacted.value(news.secret),
            });
            if (news.waitForEnabled === false) {
              return toAttributes(
                news.conduitId,
                shardId,
                news.callback,
                updated?.status ?? "webhook_callback_verification_pending",
              );
            }
            const settled = yield* waitForShard(app, news.conduitId, shardId, wait);
            const status = settled?.status ?? "webhook_callback_verification_pending";
            if (status !== "enabled") {
              yield* session.note(
                `Shard ${shardId} is ${status}; Twitch has not verified ${news.callback} yet.`,
              );
            }
            return toAttributes(news.conduitId, shardId, news.callback, status);
          }),

        delete: () => Effect.void,
      };
    }),
  );
