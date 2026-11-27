import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { TwitchApp, TwitchAppError } from "../app.ts";
import {
  createConduit,
  deleteConduit,
  findConduit,
  listConduits,
  updateConduit,
  type HelixConduit,
} from "./helix.ts";

export interface ConduitProps {
  /**
   * Number of shards. Each `consume` call configures shard `0`, so one is
   * enough until deliveries need fanning out.
   * @default 1
   */
  shardCount?: number;
  /**
   * Manage an existing conduit instead of creating one. Twitch conduits have
   * no name to look up, and an app may own at most five, so adopt by id when
   * the conduit already exists (e.g. after state was lost).
   */
  adopt?: { conduitId: string };
}

export interface ConduitAttributes {
  conduitId: string;
  shardCount: number;
  /** Adopted conduits are never deleted by Alchemy. */
  adopted: boolean;
}

/**
 * A Twitch EventSub conduit: one transport for many app-token
 * subscriptions, whose shards point at webhook callbacks.
 *
 * Retained on destroy by default: subscriptions belong to the conduit, so
 * deleting it drops every subscription users granted.
 */
export type Conduit = Resource<"Twitch.EventSub.Conduit", ConduitProps, ConduitAttributes>;

export const Conduit = Resource<Conduit>("Twitch.EventSub.Conduit", {
  defaultRemovalPolicy: "retain",
});

const DEFAULT_SHARD_COUNT = 1;

/**
 * The adopted conduit id from planned props, which may still hold
 * unresolved Outputs: a string when known, `undefined` when not adopting,
 * and `null` when it can't be known yet.
 */
const adoptedId = (news: unknown): string | undefined | null => {
  if (!Predicate.hasProperty(news, "adopt")) return undefined;
  const adopt = news.adopt;
  if (adopt === undefined) return undefined;
  if (!Predicate.hasProperty(adopt, "conduitId")) return null;
  return typeof adopt.conduitId === "string" ? adopt.conduitId : null;
};

const toAttributes = (conduit: HelixConduit, adopted: boolean): ConduitAttributes => ({
  conduitId: conduit.id,
  shardCount: conduit.shard_count,
  adopted,
});

export const ConduitProvider = () =>
  Provider.effect(
    Conduit,
    Effect.gen(function* () {
      const app = yield* TwitchApp;
      return {
        stables: ["conduitId", "adopted"],

        diff: ({ news, olds }) =>
          Effect.sync(() => {
            const next = adoptedId(news);
            const previous = olds?.adopt?.conduitId;
            // Switching which conduit is adopted is a different resource.
            if (typeof next === "string" && next !== previous) {
              return { action: "replace" } as const;
            }
            if (next === undefined && previous !== undefined) {
              return { action: "replace" } as const;
            }
            return undefined;
          }),

        read: ({ olds, output }) =>
          Effect.gen(function* () {
            const id = output?.conduitId ?? olds?.adopt?.conduitId;
            if (id === undefined) return undefined;
            const observed = yield* findConduit(app, id);
            return observed === undefined
              ? undefined
              : toAttributes(observed, output?.adopted ?? olds?.adopt !== undefined);
          }),

        reconcile: ({ news, output }) =>
          Effect.gen(function* () {
            const desired = news.shardCount ?? DEFAULT_SHARD_COUNT;
            const adoptId = news.adopt?.conduitId;
            const knownId = adoptId ?? output?.conduitId;
            const adopted = adoptId !== undefined;

            const observed = knownId === undefined ? undefined : yield* findConduit(app, knownId);
            if (observed === undefined) {
              if (adopted) {
                return yield* new TwitchAppError({
                  operation: "adoptConduit",
                  status: 404,
                  message: `Conduit ${adoptId} does not exist for this Twitch app`,
                });
              }
              return toAttributes(yield* createConduit(app, desired), false);
            }
            if (observed.shard_count !== desired) {
              return toAttributes(yield* updateConduit(app, observed.id, desired), adopted);
            }
            return toAttributes(observed, adopted);
          }),

        delete: ({ output }) => (output.adopted ? Effect.void : deleteConduit(app, output.conduitId)),

        list: () =>
          listConduits(app).pipe(
            Effect.map((conduits) => conduits.map((conduit) => toAttributes(conduit, false))),
          ),
      };
    }),
  );
