import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { SubscriptionDefinition } from "./definition.ts";
import { subscriptions } from "./subscriptions.ts";

export type { SubscriptionDefinition };
export { subscriptions };

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
  readonly version: string;
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
    readonly version: string;
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

/** The scopes a user must grant for every listed type: deduplicated and sorted. */
export const scopesFor = (types: Iterable<SubscriptionType>): Array<string> => {
  const scopes = new Set<string>();
  for (const type of types) for (const scope of subscriptions[type].scopes) scopes.add(scope);
  return [...scopes].sort();
};

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
