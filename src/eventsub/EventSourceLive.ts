import { AlchemyContext } from "alchemy/AlchemyContext";
import type {} from "alchemy/Phase";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import type { Provider } from "alchemy/Provider";
import { Random } from "alchemy/Random";
import { WebhookHost } from "alchemy/WebhookHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/http";

import { credentialsConfig, make as makeTwitchApp, type TwitchAppService } from "../app.ts";
import type { Conduit } from "./Conduit.ts";
import { ConduitShard } from "./ConduitShard.ts";
import {
  ConduitUnavailable,
  EventSubSource,
  conduitIdEnvName,
  eventSubPath,
  handleDelivery,
  secretEnvName,
  type ConsumeOptions,
  type EventSubConsumer,
  type EventSubSourceService,
  type Notification,
  type SubscriptionType,
} from "./EventSource.ts";
import { createConduitSubscription, deleteSubscription } from "./helix.ts";
import { buildCondition, scopesFor, subscriptions } from "./registry.ts";

/**
 * Declaring a resource requires its provider in the type only: the engine
 * resolves providers from the stack's `providers` at plan time, so a
 * host's init never provides them (Alchemy's own event sources erase this
 * requirement the same way).
 */
const withoutProviders = <A>(
  effect: Effect.Effect<A, never, Provider<ConduitShard> | Provider<Random>>,
): Effect.Effect<A> => effect as Effect.Effect<A>;

/** The runtime half of a consumer: typed subscribe/unsubscribe over a conduit id. */
export const makeConsumer = <K extends SubscriptionType>(input: {
  readonly app: TwitchAppService;
  readonly conduit: string;
  readonly path: string;
  readonly types: ReadonlyArray<K>;
  readonly conduitId: Effect.Effect<string | undefined>;
}): EventSubConsumer<K> => {
  const conduitId = input.conduitId.pipe(
    Effect.flatMap((id) =>
      id === undefined || id.length === 0
        ? Effect.fail(
            new ConduitUnavailable({
              conduit: input.conduit,
              message: `Conduit ${input.conduit} has no id in this runtime; deploy the stack first`,
            }),
          )
        : Effect.succeed(id),
    ),
  );
  return {
    path: input.path,
    conduitId,
    scopes: scopesFor(input.types),
    subscribe: (type, condition) =>
      Effect.gen(function* () {
        const id = yield* conduitId;
        return yield* createConduitSubscription(input.app, {
          type,
          version: String(subscriptions[type].version),
          condition: buildCondition(type, condition),
          conduitId: id,
        });
      }),
    unsubscribe: (id) => deleteSubscription(input.app, id),
  };
};

/**
 * {@link EventSubSource} on any {@link WebhookHost}, such as a Cloudflare
 * Worker.
 *
 * Reads `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` during init, so Alchemy
 * binds them onto the host for runtime `subscribe` calls.
 *
 * Deploy-time, per consumed conduit, under the host's namespace: a
 * `Random` webhook secret and (outside `alchemy dev`, whose localhost
 * Twitch can't reach) a {@link ConduitShard} pointing shard `0` at the
 * host. The shard depends on the host's URL, never the reverse; the host
 * only depends on the conduit and the secret.
 */
export const EventSubSourceLive = Layer.effect(
  EventSubSource,
  Effect.gen(function* () {
    const host = yield* WebhookHost;
    const credentials = yield* credentialsConfig;
    const app = yield* makeTwitchApp(Effect.succeed(credentials)).pipe(
      Effect.provide(FetchHttpClient.layer),
    );
    const consumed = new Set<string>();

    const source = <const Types extends ReadonlyArray<SubscriptionType>, E, R>(
      conduit: Conduit,
      types: Types,
      handler: (notification: Notification<Types[number]>) => Effect.Effect<void, E, R>,
      options: ConsumeOptions,
    ): Effect.Effect<EventSubConsumer<Types[number]>, never, R> =>
      Effect.gen(function* () {
        if (consumed.has(conduit.FQN)) {
          return yield* Effect.die(
            new Error(
              `Host '${host.LogicalId}' already consumes conduit '${conduit.LogicalId}'. List every topic in one consume call.`,
            ),
          );
        }
        consumed.add(conduit.FQN);

        const path = eventSubPath(conduit, options);
        const random = yield* Namespace.push(
          host.LogicalId,
          withoutProviders(Random(`${conduit.LogicalId}EventSubSecret`)),
        );

        if (!globalThis.__ALCHEMY_RUNTIME__) {
          yield* Namespace.push(
            host.LogicalId,
            Effect.gen(function* () {
              const context = yield* Effect.serviceOption(AlchemyContext);
              if (Option.isSome(context) && context.value.dev) {
                yield* Effect.logWarning(
                  `Twitch.EventSub.consume: no conduit shard for ${path} under alchemy dev; Twitch only delivers to public HTTPS URLs, so deploy to receive events.`,
                );
                return;
              }
              yield* withoutProviders(
                ConduitShard(`${conduit.LogicalId}Shard`, {
                  conduitId: conduit.conduitId,
                  callback: Output.interpolate`${host.url}${path}`,
                  secret: random.text,
                }),
              );
            }),
          );
        }

        // Registered on the host at deploy, read back from its env at runtime.
        const secret = yield* Output.named(random.text, secretEnvName(conduit));
        const conduitId = yield* Output.named(conduit.conduitId, conduitIdEnvName(conduit));

        yield* host.route(path, (request) =>
          handleDelivery<Types[number], E, R>({ request, secret, types, handler }),
        );

        return makeConsumer<Types[number]>({
          app,
          conduit: conduit.LogicalId,
          path,
          types,
          conduitId,
        });
      });

    return source satisfies EventSubSourceService;
  }),
);
