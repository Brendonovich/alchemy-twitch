import * as Layer from "effect/Layer";

import { layerConfigFetch } from "./app.ts";
import { ConduitProvider } from "./eventsub/Conduit.ts";
import { ConduitShardProvider } from "./eventsub/ConduitShard.ts";

/**
 * Providers for every Twitch resource, for a stack's `providers`. They call
 * Helix as the app, reading `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` on
 * first use.
 *
 * ```ts
 * providers: Layer.mergeAll(Cloudflare.providers(), Twitch.providers())
 * ```
 */
export const providers = () =>
  Layer.mergeAll(ConduitProvider(), ConduitShardProvider()).pipe(Layer.provide(layerConfigFetch));
