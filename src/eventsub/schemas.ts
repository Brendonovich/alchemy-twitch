import * as Schema from "effect/Schema";

/**
 * EventSub event payloads. Field names are Twitch's wire names; timestamps
 * decode to `Date`.
 */

const BroadcasterFields = {
  broadcaster_user_id: Schema.String,
  broadcaster_user_login: Schema.String,
  broadcaster_user_name: Schema.String,
} as const;

const UserFields = {
  user_id: Schema.String,
  user_login: Schema.String,
  user_name: Schema.String,
} as const;

const OptionalUserFields = {
  user_id: Schema.optional(Schema.NullOr(Schema.String)),
  user_login: Schema.optional(Schema.NullOr(Schema.String)),
  user_name: Schema.optional(Schema.NullOr(Schema.String)),
} as const;

/* Chat */

export const ChatEmote = Schema.Struct({
  id: Schema.String,
  emote_set_id: Schema.String,
  owner_id: Schema.String,
  format: Schema.Array(Schema.Literals(["static", "animated"])),
});

export const ChatCheermote = Schema.Struct({
  prefix: Schema.String,
  bits: Schema.Int,
  tier: Schema.Int,
});

export const ChatMention = Schema.Struct(UserFields);

export const ChatGif = Schema.Struct({ id: Schema.String, url: Schema.String });

export const ChatFragment = Schema.Struct({
  type: Schema.Literals(["text", "cheermote", "emote", "mention", "gif"]),
  text: Schema.String,
  cheermote: Schema.optional(Schema.NullOr(ChatCheermote)),
  emote: Schema.optional(Schema.NullOr(ChatEmote)),
  mention: Schema.optional(Schema.NullOr(ChatMention)),
  gif: Schema.optional(Schema.NullOr(ChatGif)),
});

export const ChatMessage = Schema.Struct({
  text: Schema.String,
  fragments: Schema.Array(ChatFragment),
});

export const ChatBadge = Schema.Struct({
  set_id: Schema.String,
  id: Schema.String,
  info: Schema.String,
});

export const ChatReply = Schema.Struct({
  parent_message_id: Schema.String,
  parent_message_body: Schema.String,
  parent_user_id: Schema.String,
  parent_user_login: Schema.String,
  parent_user_name: Schema.String,
  thread_message_id: Schema.String,
  thread_user_id: Schema.String,
  thread_user_login: Schema.String,
  thread_user_name: Schema.String,
});

export const ChatMessageType = Schema.Literals([
  "text",
  "channel_points_highlighted",
  "channel_points_sub_only",
  "user_intro",
  "power_ups_message_effect",
  "power_ups_gigantified_emote",
]);

export const ChatMessagePayload = Schema.Struct({
  ...BroadcasterFields,
  chatter_user_id: Schema.String,
  chatter_user_login: Schema.String,
  chatter_user_name: Schema.String,
  message_id: Schema.String,
  message: ChatMessage,
  color: Schema.String,
  badges: Schema.Array(ChatBadge),
  message_type: ChatMessageType,
  cheer: Schema.optional(Schema.NullOr(Schema.Struct({ bits: Schema.Int }))),
  reply: Schema.optional(Schema.NullOr(ChatReply)),
  channel_points_custom_reward_id: Schema.optional(Schema.NullOr(Schema.String)),
  channel_points_animation_id: Schema.optional(Schema.NullOr(Schema.String)),
  source_broadcaster_user_id: Schema.optional(Schema.NullOr(Schema.String)),
  source_broadcaster_user_login: Schema.optional(Schema.NullOr(Schema.String)),
  source_broadcaster_user_name: Schema.optional(Schema.NullOr(Schema.String)),
  source_message_id: Schema.optional(Schema.NullOr(Schema.String)),
  source_badges: Schema.optional(Schema.NullOr(Schema.Array(ChatBadge))),
  is_source_only: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

/* Channel */

export const FollowPayload = Schema.Struct({
  ...UserFields,
  ...BroadcasterFields,
  followed_at: Schema.DateFromString,
});

export const SubscriptionTier = Schema.Literals(["1000", "2000", "3000"]);

export const SubscribePayload = Schema.Struct({
  ...UserFields,
  ...BroadcasterFields,
  tier: SubscriptionTier,
  is_gift: Schema.Boolean,
});

export const SubscriptionGiftPayload = Schema.Struct({
  ...OptionalUserFields,
  ...BroadcasterFields,
  total: Schema.Int,
  tier: SubscriptionTier,
  cumulative_total: Schema.optional(Schema.NullOr(Schema.Int)),
  is_anonymous: Schema.Boolean,
});

export const SubscriptionMessagePayload = Schema.Struct({
  ...UserFields,
  ...BroadcasterFields,
  tier: SubscriptionTier,
  message: Schema.Struct({
    text: Schema.String,
    emotes: Schema.Array(Schema.Struct({ begin: Schema.Int, end: Schema.Int, id: Schema.String })),
  }),
  cumulative_months: Schema.Int,
  streak_months: Schema.optional(Schema.NullOr(Schema.Int)),
  duration_months: Schema.Int,
});

export const CheerPayload = Schema.Struct({
  is_anonymous: Schema.Boolean,
  ...OptionalUserFields,
  ...BroadcasterFields,
  message: Schema.String,
  bits: Schema.Int,
});

export const RaidPayload = Schema.Struct({
  from_broadcaster_user_id: Schema.String,
  from_broadcaster_user_login: Schema.String,
  from_broadcaster_user_name: Schema.String,
  to_broadcaster_user_id: Schema.String,
  to_broadcaster_user_login: Schema.String,
  to_broadcaster_user_name: Schema.String,
  viewers: Schema.Int,
});

export const ChannelUpdatePayload = Schema.Struct({
  ...BroadcasterFields,
  title: Schema.String,
  language: Schema.String,
  category_id: Schema.String,
  category_name: Schema.String,
  content_classification_labels: Schema.Array(Schema.String),
});

export const ChannelPointsRedemptionPayload = Schema.Struct({
  id: Schema.String,
  ...BroadcasterFields,
  ...UserFields,
  user_input: Schema.String,
  status: Schema.Literals(["unknown", "unfulfilled", "fulfilled", "canceled"]),
  reward: Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    cost: Schema.Int,
    prompt: Schema.String,
  }),
  redeemed_at: Schema.DateFromString,
});

/* Stream */

export const StreamOnlinePayload = Schema.Struct({
  id: Schema.String,
  ...BroadcasterFields,
  type: Schema.Literal("live"),
  started_at: Schema.DateFromString,
});

export const StreamOfflinePayload = Schema.Struct({
  id: Schema.optional(Schema.String),
  ...BroadcasterFields,
});

/* User authorization */

export const AuthorizationGrantPayload = Schema.Struct({
  client_id: Schema.String,
  ...UserFields,
});

/** `user_login`/`user_name` are null when the user no longer exists. */
export const AuthorizationRevokePayload = Schema.Struct({
  client_id: Schema.String,
  user_id: Schema.String,
  user_login: Schema.NullOr(Schema.String),
  user_name: Schema.NullOr(Schema.String),
});

/* Conduit */

export const ConduitShardDisabledPayload = Schema.Struct({
  conduit_id: Schema.String,
  shard_id: Schema.String,
  status: Schema.String,
  transport: Schema.Struct({
    method: Schema.Literals(["webhook", "websocket"]),
    callback: Schema.optional(Schema.NullOr(Schema.String)),
    session_id: Schema.optional(Schema.NullOr(Schema.String)),
    connected_at: Schema.optional(Schema.NullOr(Schema.DateFromString)),
    disconnected_at: Schema.optional(Schema.NullOr(Schema.DateFromString)),
  }),
});
