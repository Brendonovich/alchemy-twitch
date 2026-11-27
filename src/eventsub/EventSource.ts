import { sanitizeKey } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import type { TwitchAppError } from "../app.ts";
import type { Conduit } from "./Conduit.ts";
import type { CreatedSubscription } from "./helix.ts";
import {
  decodeEvent,
  type ConditionOf,
  type NotificationFor,
  type SubscriptionNotification,
  type SubscriptionType,
} from "./registry.ts";
import { decodeWebhook, type WebhookSubscription } from "./webhook.ts";

export type { SubscriptionType };

/** Delivery metadata attached to every notification. */
export interface NotificationDetails {
  readonly messageId: string;
  /** The timestamp Twitch put in the message metadata. */
  readonly messageTimestamp: Date;
  /** When this runtime decoded the message. */
  readonly receivedAt: Date;
  readonly subscription: WebhookSubscription;
}

/** A decoded delivery for one of the listed subscription types. */
export type Notification<K extends SubscriptionType> = K extends SubscriptionType
  ? NotificationFor<K> & NotificationDetails
  : never;

/** The conduit id isn't available to this runtime (not deployed yet). */
export class ConduitUnavailable extends Data.TaggedError("ConduitUnavailable")<{
  readonly conduit: string;
  readonly message: string;
}> {}

export interface ConsumeOptions {
  /** Path on the host that Twitch delivers to. Defaults to `/twitch/eventsub/<conduit>`. */
  readonly path?: string;
}

/** What `consume` returns: subscribe the conduit to the listed types only. */
export interface EventSubConsumer<K extends SubscriptionType> {
  readonly path: string;
  readonly conduitId: Effect.Effect<string, ConduitUnavailable>;
  /**
   * Create an app-token subscription delivered over the conduit. A 409 (the
   * same subscription exists) succeeds with `created: false` and the
   * existing id when Twitch lists it.
   */
  readonly subscribe: <T extends K>(
    type: T,
    condition: ConditionOf<T>,
  ) => Effect.Effect<CreatedSubscription, TwitchAppError | ConduitUnavailable>;
  /** Delete a subscription. Unknown ids succeed. */
  readonly unsubscribe: (id: string) => Effect.Effect<void, TwitchAppError>;
}

export type EventSubSourceService = <
  const Types extends ReadonlyArray<SubscriptionType>,
  E = never,
  R = never,
>(
  conduit: Conduit,
  types: Types,
  handler: (notification: Notification<Types[number]>) => Effect.Effect<void, E, R>,
  options: ConsumeOptions,
) => Effect.Effect<EventSubConsumer<Types[number]>, never, R>;

export class EventSubSource extends Context.Service<EventSubSource, EventSubSourceService>()(
  "Ballast/Alchemy/Twitch.EventSub.EventSource",
) {}

/**
 * Receive Twitch EventSub notifications for `types` on this host (a
 * Cloudflare Worker) through `conduit`.
 *
 * Deploy-time: generates a webhook secret and points the conduit's shard
 * `0` at the host's URL. Runtime: verifies and answers Twitch's deliveries
 * and runs `handler` once per notification of a listed type.
 *
 * ```ts
 * const conduit = yield* Twitch.EventSub.Conduit("BotConduit");
 * const eventsub = yield* Twitch.EventSub.consume(
 *   conduit,
 *   ["channel.chat.message", "channel.follow"],
 *   (event) => Effect.log(event.type),
 * );
 * yield* eventsub.subscribe("channel.follow", { broadcaster_user_id, moderator_user_id });
 * ```
 */
export function consume<const Types extends ReadonlyArray<SubscriptionType>, E = never, R = never>(
  conduit: Conduit,
  types: Types,
  handler: (notification: Notification<Types[number]>) => Effect.Effect<void, E, R>,
  options: ConsumeOptions = {},
): Effect.Effect<EventSubConsumer<Types[number]>, never, EventSubSource | R> {
  return EventSubSource.use((source) => source(conduit, types, handler, options));
}

export const eventSubPath = (conduit: Pick<Conduit, "LogicalId">, options: ConsumeOptions = {}) =>
  options.path ?? `/twitch/eventsub/${encodeURIComponent(conduit.LogicalId)}`;

/** Env var holding the webhook secret on the host. */
export const secretEnvName = (conduit: Pick<Conduit, "LogicalId">) =>
  `TWITCH_EVENTSUB_SECRET_${sanitizeKey(conduit.LogicalId)}`;

/** Env var holding the conduit id on the host. */
export const conduitIdEnvName = (conduit: Pick<Conduit, "LogicalId">) =>
  `TWITCH_EVENTSUB_CONDUIT_${sanitizeKey(conduit.LogicalId)}`;

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain" } });

export interface DeliveryOptions<K extends SubscriptionType, E, R> {
  readonly request: Request;
  readonly secret: Effect.Effect<Redacted.Redacted<string> | undefined>;
  readonly types: ReadonlyArray<K>;
  readonly handler: (notification: Notification<K>) => Effect.Effect<void, E, R>;
  /** Overridable for tests. */
  readonly now?: number;
}

/**
 * Handle one EventSub webhook request: verify the HMAC over the raw body and
 * the ten-minute window, answer the challenge, acknowledge revocations, and
 * dispatch notifications of listed types.
 */
export const handleDelivery = <K extends SubscriptionType, E, R>(
  options: DeliveryOptions<K, E, R>,
): Effect.Effect<Response, never, R> =>
  Effect.gen(function* () {
    const { request } = options;
    if (request.method !== "POST") return text(405, "method not allowed");
    const secret = yield* options.secret;
    if (secret === undefined) return text(500, "webhook secret missing");

    const body = new Uint8Array(yield* Effect.promise(() => request.arrayBuffer()));
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const decoded = yield* decodeWebhook({
      headers,
      body,
      secret: Redacted.value(secret),
      ...(options.now === undefined ? {} : { now: options.now }),
    }).pipe(Effect.result);
    if (decoded._tag === "Failure") {
      const error = decoded.failure;
      if (error._tag === "WebhookVerificationError") {
        yield* Effect.logWarning(`Rejected EventSub delivery: ${error.reason}`);
        return text(403, "invalid signature");
      }
      return text(400, "invalid payload");
    }
    const delivery = decoded.success;

    switch (delivery._tag) {
      case "verification":
        return text(200, delivery.challenge);
      case "revocation":
        yield* Effect.logWarning(
          `EventSub subscription ${delivery.subscription.id} (${delivery.subscription.type}) revoked: ${delivery.subscription.status}`,
        );
        return new Response(null, { status: 204 });
      case "notification": {
        const listed: ReadonlyArray<string> = options.types;
        if (!listed.includes(delivery.subscription.type)) {
          return new Response(null, { status: 204 });
        }
        const notification = yield* decodeEvent(delivery.subscription.type, delivery.event).pipe(
          Effect.map((event) => ({
            ...event,
            messageId: delivery.messageId,
            messageTimestamp: delivery.messageTimestamp,
            receivedAt: delivery.receivedAt,
            subscription: delivery.subscription,
          })),
          Effect.result,
        );
        if (notification._tag === "Failure") {
          yield* Effect.logError(
            `Could not decode ${delivery.subscription.type} notification ${delivery.messageId}`,
            notification.failure,
          );
          return text(400, "invalid event");
        }
        if (!isListed(notification.success, options.types)) {
          return new Response(null, { status: 204 });
        }
        const handled = yield* options.handler(notification.success).pipe(Effect.exit);
        if (handled._tag === "Failure") {
          yield* Effect.logError(
            `EventSub handler failed for ${delivery.subscription.type} ${delivery.messageId}`,
            handled.cause,
          );
          return text(500, "handler failed");
        }
        return new Response(null, { status: 204 });
      }
    }
  });

const isListed = <K extends SubscriptionType>(
  notification: SubscriptionNotification & NotificationDetails,
  types: ReadonlyArray<K>,
): notification is Notification<K> => {
  const listed: ReadonlyArray<string> = types;
  return listed.includes(notification.type);
};
