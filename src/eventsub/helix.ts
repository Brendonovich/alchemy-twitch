import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { errorMessage, TwitchAppError, type HelixReply, type TwitchAppService } from "../app.ts";

/** Helix EventSub endpoints for conduits, shards and conduit subscriptions. */

export const HelixConduit = Schema.Struct({
  id: Schema.String,
  shard_count: Schema.Number,
});
export type HelixConduit = Schema.Schema.Type<typeof HelixConduit>;

export const HelixShard = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  transport: Schema.Struct({
    method: Schema.String,
    callback: Schema.optional(Schema.String),
    session_id: Schema.optional(Schema.String),
  }),
});
export type HelixShard = Schema.Schema.Type<typeof HelixShard>;

export const HelixShardError = Schema.Struct({
  id: Schema.String,
  message: Schema.String,
  code: Schema.String,
});

export const HelixSubscription = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  type: Schema.String,
  version: Schema.String,
  condition: Schema.Record(Schema.String, Schema.String),
  transport: Schema.Struct({
    method: Schema.String,
    conduit_id: Schema.optional(Schema.String),
  }),
});
export type HelixSubscription = Schema.Schema.Type<typeof HelixSubscription>;

const Pagination = Schema.optional(Schema.Struct({ cursor: Schema.optional(Schema.String) }));

const ConduitList = Schema.Struct({ data: Schema.Array(HelixConduit) });
const ShardList = Schema.Struct({ data: Schema.Array(HelixShard), pagination: Pagination });
const ShardUpdate = Schema.Struct({
  data: Schema.optional(Schema.Array(HelixShard)),
  errors: Schema.optional(Schema.Array(HelixShardError)),
});
const SubscriptionList = Schema.Struct({
  data: Schema.Array(HelixSubscription),
  pagination: Pagination,
});

const ok = (reply: HelixReply): boolean => reply.status >= 200 && reply.status < 300;

const fail = (operation: string, reply: HelixReply) =>
  new TwitchAppError({
    operation,
    status: reply.status,
    message: errorMessage(reply.body, `Twitch answered ${reply.status}`),
    body: reply.body,
  });

const decode = <S extends Schema.Codec<any, unknown, never, never>>(
  schema: S,
  operation: string,
  reply: HelixReply,
): Effect.Effect<S["Type"], TwitchAppError> =>
  Schema.decodeUnknownEffect(schema)(reply.body).pipe(
    Effect.mapError(
      (cause) =>
        new TwitchAppError({
          operation,
          status: reply.status,
          message: `Unexpected Twitch response: ${cause.message}`,
          body: reply.body,
        }),
    ),
  );

const expect = <S extends Schema.Codec<any, unknown, never, never>>(
  app: TwitchAppService,
  operation: string,
  call: Parameters<TwitchAppService["helix"]>[0],
  schema: S,
): Effect.Effect<S["Type"], TwitchAppError> =>
  app.helix(call).pipe(
    Effect.flatMap((reply) =>
      ok(reply) ? decode(schema, operation, reply) : Effect.fail(fail(operation, reply)),
    ),
  );

export const listConduits = (app: TwitchAppService) =>
  expect(app, "getConduits", { method: "GET", path: "/eventsub/conduits" }, ConduitList).pipe(
    Effect.map((list) => list.data),
  );

export const findConduit = (app: TwitchAppService, id: string) =>
  listConduits(app).pipe(Effect.map((conduits) => conduits.find((conduit) => conduit.id === id)));

export const createConduit = (app: TwitchAppService, shardCount: number) =>
  expect(
    app,
    "createConduit",
    { method: "POST", path: "/eventsub/conduits", body: { shard_count: shardCount } },
    ConduitList,
  ).pipe(
    Effect.flatMap((list) =>
      list.data[0] === undefined
        ? Effect.fail(
            new TwitchAppError({
              operation: "createConduit",
              status: 200,
              message: "Twitch returned no conduit",
            }),
          )
        : Effect.succeed(list.data[0]),
    ),
  );

export const updateConduit = (app: TwitchAppService, id: string, shardCount: number) =>
  expect(
    app,
    "updateConduit",
    { method: "PATCH", path: "/eventsub/conduits", body: { id, shard_count: shardCount } },
    ConduitList,
  ).pipe(Effect.map((list) => list.data[0] ?? { id, shard_count: shardCount }));

/** Idempotent: a conduit that is already gone counts as deleted. */
export const deleteConduit = (app: TwitchAppService, id: string) =>
  app.helix({ method: "DELETE", path: "/eventsub/conduits", query: { id } }).pipe(
    Effect.flatMap((reply) =>
      ok(reply) || reply.status === 404 ? Effect.void : Effect.fail(fail("deleteConduit", reply)),
    ),
  );

export const listShards = (app: TwitchAppService, conduitId: string) =>
  Effect.gen(function* () {
    const shards: Array<HelixShard> = [];
    let after: string | undefined;
    do {
      const page = yield* expect(
        app,
        "getConduitShards",
        {
          method: "GET",
          path: "/eventsub/conduits/shards",
          query: after === undefined ? { conduit_id: conduitId } : { conduit_id: conduitId, after },
        },
        ShardList,
      );
      shards.push(...page.data);
      after = page.pagination?.cursor || undefined;
    } while (after !== undefined);
    return shards;
  });

export const findShard = (app: TwitchAppService, conduitId: string, shardId: string) =>
  listShards(app, conduitId).pipe(
    Effect.map((shards) => shards.find((shard) => shard.id === shardId)),
  );

export const updateShard = (
  app: TwitchAppService,
  input: {
    readonly conduitId: string;
    readonly shardId: string;
    readonly callback: string;
    readonly secret: string;
  },
) =>
  expect(
    app,
    "updateConduitShards",
    {
      method: "PATCH",
      path: "/eventsub/conduits/shards",
      body: {
        conduit_id: input.conduitId,
        shards: [
          {
            id: input.shardId,
            transport: { method: "webhook", callback: input.callback, secret: input.secret },
          },
        ],
      },
    },
    ShardUpdate,
  ).pipe(
    Effect.flatMap((result) => {
      const error = result.errors?.find((entry) => entry.id === input.shardId);
      return error === undefined
        ? Effect.succeed(result.data?.find((shard) => shard.id === input.shardId))
        : Effect.fail(
            new TwitchAppError({
              operation: "updateConduitShards",
              status: 202,
              message: `Shard ${error.id}: ${error.message} (${error.code})`,
              body: result,
            }),
          );
    }),
  );

export interface CreatedSubscription {
  /** Undefined only when Twitch reported a duplicate that could not be found again. */
  readonly id: string | undefined;
  readonly status: string;
  /** False when Twitch answered 409: an identical subscription already exists. */
  readonly created: boolean;
}

const sameCondition = (
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean => Object.entries(expected).every(([key, value]) => actual[key] === value);

const MAX_LOOKUP_PAGES = 10;

/** Find a conduit subscription by type, condition and conduit, for a 409. */
export const findConduitSubscription = (
  app: TwitchAppService,
  input: {
    readonly type: string;
    readonly condition: Readonly<Record<string, string>>;
    readonly conduitId: string;
  },
) =>
  Effect.gen(function* () {
    let after: string | undefined;
    for (let page = 0; page < MAX_LOOKUP_PAGES; page += 1) {
      const list = yield* expect(
        app,
        "getEventSubSubscriptions",
        {
          method: "GET",
          path: "/eventsub/subscriptions",
          query: after === undefined ? { type: input.type } : { type: input.type, after },
        },
        SubscriptionList,
      );
      const match = list.data.find(
        (subscription) =>
          subscription.type === input.type &&
          subscription.transport.method === "conduit" &&
          subscription.transport.conduit_id === input.conduitId &&
          sameCondition(subscription.condition, input.condition),
      );
      if (match !== undefined) return match;
      after = list.pagination?.cursor || undefined;
      if (after === undefined) return undefined;
    }
    return undefined;
  });

export const createConduitSubscription = (
  app: TwitchAppService,
  input: {
    readonly type: string;
    readonly version: string;
    readonly condition: Readonly<Record<string, string>>;
    readonly conduitId: string;
  },
): Effect.Effect<CreatedSubscription, TwitchAppError> =>
  Effect.gen(function* () {
    const reply = yield* app.helix({
      method: "POST",
      path: "/eventsub/subscriptions",
      body: {
        type: input.type,
        version: input.version,
        condition: input.condition,
        transport: { method: "conduit", conduit_id: input.conduitId },
      },
    });
    if (reply.status === 409) {
      const existing = yield* findConduitSubscription(app, input);
      return {
        id: existing?.id,
        status: existing?.status ?? "enabled",
        created: false,
      };
    }
    if (!ok(reply)) return yield* fail("createEventSubSubscription", reply);
    const list = yield* decode(SubscriptionList, "createEventSubSubscription", reply);
    const created = list.data[0];
    if (created === undefined) {
      return yield* new TwitchAppError({
        operation: "createEventSubSubscription",
        status: reply.status,
        message: "Twitch returned no subscription",
      });
    }
    return { id: created.id, status: created.status, created: true };
  });

/** Idempotent: an unknown subscription counts as deleted. */
export const deleteSubscription = (app: TwitchAppService, id: string) =>
  app.helix({ method: "DELETE", path: "/eventsub/subscriptions", query: { id } }).pipe(
    Effect.flatMap((reply) =>
      ok(reply) || reply.status === 404
        ? Effect.void
        : Effect.fail(fail("deleteEventSubSubscription", reply)),
    ),
  );
