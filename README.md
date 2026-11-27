# alchemy-twitch

Twitch EventSub resources for [Alchemy](https://alchemy.run) v2, written with [Effect](https://effect.website) v4.

- `Twitch.EventSub.Conduit`: an EventSub conduit owned by your Twitch app.
- `Twitch.EventSub.consume`: points the conduit at a Cloudflare Worker, verifies Twitch's signed webhook deliveries and hands you typed, decoded notifications.
- `Twitch.providers()`: the Alchemy providers for these resources.

## Install

```sh
pnpm add github:brendonovich/alchemy-twitch alchemy @alchemy.run/cloudflare effect
```

The package ships TypeScript source, so your bundler or runtime has to load `.ts` files.

## EventSub example

```ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Twitch from "alchemy-twitch";

export class Bot extends Cloudflare.Worker<Bot>()(
  "TwitchBot",
  { main: import.meta.url },
  Effect.gen(function* () {
    const conduit = yield* Twitch.EventSub.Conduit("BotConduit");
    const eventsub = yield* Twitch.EventSub.consume(
      conduit,
      ["channel.follow", "stream.online"],
      (event) => {
        switch (event.type) {
          case "channel.follow":
            return Effect.log(`${event.payload.user_login} followed`);
          case "stream.online":
            return Effect.log(`${event.payload.broadcaster_user_login} went live`);
        }
      },
    );

    return {
      // Subscribe a channel at runtime, e.g. from an OAuth callback.
      fetch: Effect.all([
        eventsub.subscribe("channel.follow", { broadcaster_user_id: "123", moderator_user_id: "456" }),
        eventsub.subscribe("stream.online", { broadcaster_user_id: "123" }),
      ]).pipe(Effect.as(HttpServerResponse.text("subscribed")), Effect.orDie),
    };
  }).pipe(Effect.provide(Twitch.EventSub.EventSubSourceLive)),
) {}
```

Add `Twitch.providers()` to your stack's providers, set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`, and deploy. Deploying creates the conduit and points it at the Worker; the Worker verifies each delivery and calls your handler with a typed event. A fuller bot is in [`example/`](./example).

### Notes

- Conduits are kept when the resource is destroyed, because deleting a conduit drops every subscription on it. A Twitch app can own at most five conduits; to manage one that already exists, use `Conduit("BotConduit", { adopt: { conduitId } })`.
- `subscribe` succeeds with `created: false` if the subscription already exists. `unsubscribe` succeeds for ids Twitch doesn't know.
- Revocations are logged and acknowledged. A failing handler returns 500 so Twitch retries the delivery.

### Supported subscription types

`channel.chat.message`, `channel.follow`, `channel.subscribe`, `channel.subscription.gift`, `channel.subscription.message`, `channel.cheer`, `channel.raid`, `channel.update`, `stream.online`, `stream.offline`, `user.authorization.grant`, `user.authorization.revoke`, `conduit.shard.disabled`.

### Without Alchemy

The webhook helpers work on their own. `Twitch.EventSub.decodeWebhook({ headers, body, secret })` checks the HMAC signature and the ten-minute timestamp window, then returns a `verification`, `notification` or `revocation` delivery. `Twitch.EventSub.decodeEvent(type, event)` decodes a notification payload.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
```
