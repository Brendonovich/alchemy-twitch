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

A Worker that logs chat messages and follows for any channel that authorizes the bot.

```ts
// bot-worker.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Twitch from "alchemy-twitch";

export class Bot extends Cloudflare.Worker<Bot>()(
  "TwitchBot",
  { main: import.meta.url },
  Effect.gen(function* () {
    const botUserId = yield* Config.String("TWITCH_BOT_USER_ID");

    // Created at deploy time.
    const conduit = yield* Twitch.EventSub.Conduit("BotConduit");

    // At deploy time this generates a webhook secret and points shard 0 of
    // the conduit at this Worker. At runtime it verifies each delivery and
    // calls the handler for the listed types.
    const eventsub = yield* Twitch.EventSub.consume(
      conduit,
      ["channel.chat.message", "channel.follow"],
      (event) => {
        switch (event.type) {
          case "channel.chat.message":
            return Effect.log(`${event.payload.chatter_user_login}: ${event.payload.message.text}`);
          case "channel.follow":
            return Effect.log(`${event.payload.user_login} followed`);
        }
      },
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const broadcasterId = url.searchParams.get("broadcaster_id");
        if (url.pathname !== "/subscribe" || broadcasterId === null) {
          return HttpServerResponse.text("not found", { status: 404 });
        }

        // Subscriptions are created at runtime. The condition is typed
        // per subscription type.
        const chat = yield* eventsub.subscribe("channel.chat.message", {
          broadcaster_user_id: broadcasterId,
          user_id: botUserId,
        });
        const follows = yield* eventsub.subscribe("channel.follow", {
          broadcaster_user_id: broadcasterId,
          moderator_user_id: botUserId,
        });
        return yield* HttpServerResponse.json({ chat, follows });
      }).pipe(
        Effect.catchTags({
          TwitchAppError: (error) => Effect.succeed(HttpServerResponse.text(error.message, { status: 502 })),
          ConduitUnavailable: (error) => Effect.succeed(HttpServerResponse.text(error.message, { status: 503 })),
        }),
      ),
    };
  }).pipe(Effect.provide(Twitch.EventSub.EventSubSourceLive)),
) {}

export default Bot;
```

```ts
// alchemy.run.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Twitch from "alchemy-twitch";
import { Bot } from "./bot-worker.ts";

export default Alchemy.Stack(
  "TwitchBot",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Twitch.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const bot = yield* Bot;
    return { url: bot.url };
  }),
);
```

Set `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` and `TWITCH_BOT_USER_ID`, then deploy:

```sh
alchemy deploy alchemy.run.ts
```

Deliveries go to `/twitch/eventsub/<conduit>` on the Worker by default; pass `{ path }` as the fourth argument to `consume` to change it. Once deployed, open `/subscribe?broadcaster_id=…` for a broadcaster who has granted the bot `channel:bot` and given it moderator access (`channel.follow` needs a moderator).

The full example is in [`example/`](./example).

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
