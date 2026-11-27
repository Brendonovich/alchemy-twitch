import type * as Schema from "effect/Schema";

/** One EventSub subscription type: its version, condition, payload and scopes. */
export interface SubscriptionDefinition<
  Type extends string,
  Condition extends Readonly<Record<string, string | undefined>>,
  Payload,
> {
  readonly type: Type;
  /** Twitch's version string, e.g. `"2"` or `"beta"`. */
  readonly version: string;
  readonly condition: Schema.Codec<Condition, unknown, never, never>;
  readonly payload: Schema.Codec<Payload, unknown, never, never>;
  /**
   * The least-privileged scopes the users named in the condition must have
   * granted the app. Empty means none.
   */
  readonly scopes: ReadonlyArray<string>;
}

export const define = <
  const Type extends string,
  Condition extends Readonly<Record<string, string | undefined>>,
  Payload,
>(
  definition: SubscriptionDefinition<Type, Condition, Payload>,
): SubscriptionDefinition<Type, Condition, Payload> => definition;
