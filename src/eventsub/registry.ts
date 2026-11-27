import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  AuthorizationGrantPayload,
  AuthorizationRevokePayload,
  ChannelPointsRedemptionPayload,
  ChannelUpdatePayload,
  ChatMessagePayload,
  CheerPayload,
  ConduitShardDisabledPayload,
  FollowPayload,
  RaidPayload,
  StreamOfflinePayload,
  StreamOnlinePayload,
  SubscribePayload,
  SubscriptionGiftPayload,
  SubscriptionMessagePayload,
} from "./schemas.ts";

/** One EventSub subscription type: its version, condition, payload and scopes. */
export interface SubscriptionDefinition<
  Type extends string,
  Condition extends Readonly<Record<string, string | undefined>>,
  Payload,
> {
  readonly type: Type;
  readonly version: number;
  readonly condition: Schema.Codec<Condition, unknown, never, never>;
  readonly payload: Schema.Codec<Payload, unknown, never, never>;
  /** Scopes the authorizing user must have granted. Empty means none. */
  readonly scopes: ReadonlyArray<string>;
}

const define = <
  const Type extends string,
  Condition extends Readonly<Record<string, string | undefined>>,
  Payload,
>(
  definition: SubscriptionDefinition<Type, Condition, Payload>,
): SubscriptionDefinition<Type, Condition, Payload> => definition;

const Broadcaster = Schema.Struct({ broadcaster_user_id: Schema.String });

const RaidCondition = Schema.Struct({
  from_broadcaster_user_id: Schema.optional(Schema.String),
  to_broadcaster_user_id: Schema.optional(Schema.String),
}).check(
  Schema.makeFilter(
    (condition) =>
      (condition.from_broadcaster_user_id === undefined) !==
        (condition.to_broadcaster_user_id === undefined) ||
      "set exactly one of from_broadcaster_user_id or to_broadcaster_user_id",
  ),
);

/** The subscription types this package can consume and subscribe to. */
export const subscriptions = {
  "channel.chat.message": define({
    type: "channel.chat.message",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String, user_id: Schema.String }),
    payload: ChatMessagePayload,
    scopes: ["user:read:chat"],
  }),
  "channel.follow": define({
    type: "channel.follow",
    version: 2,
    condition: Schema.Struct({
      broadcaster_user_id: Schema.String,
      moderator_user_id: Schema.String,
    }),
    payload: FollowPayload,
    scopes: ["moderator:read:followers"],
  }),
  "channel.subscribe": define({
    type: "channel.subscribe",
    version: 1,
    condition: Broadcaster,
    payload: SubscribePayload,
    scopes: ["channel:read:subscriptions"],
  }),
  "channel.subscription.gift": define({
    type: "channel.subscription.gift",
    version: 1,
    condition: Broadcaster,
    payload: SubscriptionGiftPayload,
    scopes: ["channel:read:subscriptions"],
  }),
  "channel.subscription.message": define({
    type: "channel.subscription.message",
    version: 1,
    condition: Broadcaster,
    payload: SubscriptionMessagePayload,
    scopes: ["channel:read:subscriptions"],
  }),
  "channel.cheer": define({
    type: "channel.cheer",
    version: 1,
    condition: Broadcaster,
    payload: CheerPayload,
    scopes: ["bits:read"],
  }),
  "channel.raid": define({
    type: "channel.raid",
    version: 1,
    condition: RaidCondition,
    payload: RaidPayload,
    scopes: [],
  }),
  "channel.update": define({
    type: "channel.update",
    version: 2,
    condition: Broadcaster,
    payload: ChannelUpdatePayload,
    scopes: [],
  }),
  "channel.channel_points_custom_reward_redemption.add": define({
    type: "channel.channel_points_custom_reward_redemption.add",
    version: 1,
    condition: Schema.Struct({
      broadcaster_user_id: Schema.String,
      reward_id: Schema.optional(Schema.String),
    }),
    payload: ChannelPointsRedemptionPayload,
    scopes: ["channel:read:redemptions"],
  }),
  "stream.online": define({
    type: "stream.online",
    version: 1,
    condition: Broadcaster,
    payload: StreamOnlinePayload,
    scopes: [],
  }),
  "stream.offline": define({
    type: "stream.offline",
    version: 1,
    condition: Broadcaster,
    payload: StreamOfflinePayload,
    scopes: [],
  }),
  "user.authorization.grant": define({
    type: "user.authorization.grant",
    version: 1,
    condition: Schema.Struct({ client_id: Schema.String }),
    payload: AuthorizationGrantPayload,
    scopes: [],
  }),
  "user.authorization.revoke": define({
    type: "user.authorization.revoke",
    version: 1,
    condition: Schema.Struct({ client_id: Schema.String }),
    payload: AuthorizationRevokePayload,
    scopes: [],
  }),
  "conduit.shard.disabled": define({
    type: "conduit.shard.disabled",
    version: 1,
    condition: Schema.Struct({
      client_id: Schema.String,
      conduit_id: Schema.optional(Schema.String),
    }),
    payload: ConduitShardDisabledPayload,
    scopes: [],
  }),
} as const;

export type SubscriptionType = keyof typeof subscriptions;
export type SubscriptionDefinitionFor<K extends SubscriptionType> = (typeof subscriptions)[K];
export type ConditionOf<K extends SubscriptionType> = Schema.Schema.Type<
  SubscriptionDefinitionFor<K>["condition"]
>;
export type PayloadOf<K extends SubscriptionType> = Schema.Schema.Type<
  SubscriptionDefinitionFor<K>["payload"]
>;

/** A decoded event of type `K`. */
export interface NotificationFor<K extends SubscriptionType> {
  readonly type: K;
  readonly version: number;
  readonly payload: PayloadOf<K>;
}

/** Every decoded event, discriminated by `type`. */
export type SubscriptionNotification = {
  [K in SubscriptionType]: NotificationFor<K>;
}[SubscriptionType];

export const isSubscriptionType = (value: string): value is SubscriptionType =>
  Object.hasOwn(subscriptions, value);

export class UnknownSubscriptionType extends Data.TaggedError("UnknownSubscriptionType")<{
  readonly type: string;
}> {}

type Decoder = (payload: unknown) => Effect.Effect<SubscriptionNotification, Schema.SchemaError>;

// Each type's payload codec is only ever paired with its own `type`, so the
// decoded value is that member of the union.
const decoderFor = (type: SubscriptionType): Decoder => {
  const definition: {
    readonly version: number;
    readonly payload: Schema.Codec<unknown, unknown, never, never>;
  } = subscriptions[type];
  return (payload) =>
    Effect.map(
      Schema.decodeUnknownEffect(definition.payload)(payload),
      (decoded) =>
        ({ type, version: definition.version, payload: decoded }) as SubscriptionNotification,
    );
};

const decoders = Object.fromEntries(
  (Object.keys(subscriptions) as Array<SubscriptionType>).map((type) => [type, decoderFor(type)]),
) as Record<SubscriptionType, Decoder>;

/** Decode an event payload by its subscription type. */
export const decodeEvent = (
  type: string,
  payload: unknown,
): Effect.Effect<SubscriptionNotification, Schema.SchemaError | UnknownSubscriptionType> =>
  isSubscriptionType(type)
    ? decoders[type](payload)
    : Effect.fail(new UnknownSubscriptionType({ type }));

/**
 * Validate a condition against its type and drop unset optional keys,
 * producing the flat string record Twitch expects.
 */
export const buildCondition = <K extends SubscriptionType>(
  type: K,
  condition: ConditionOf<K>,
): Readonly<Record<string, string>> => {
  const schema: Schema.Codec<unknown, unknown, never, never> = subscriptions[type].condition;
  const encoded: unknown = Schema.encodeSync(schema)(condition);
  const record: Record<string, string> = {};
  if (typeof encoded === "object" && encoded !== null) {
    for (const [key, value] of Object.entries(encoded)) {
      if (typeof value === "string") record[key] = value;
    }
  }
  return record;
};
