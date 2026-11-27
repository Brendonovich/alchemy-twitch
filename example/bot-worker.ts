import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as Twitch from "../src/index.ts";

/**
 * A chat bot Worker. Twitch delivers its EventSub notifications through a
 * conduit whose shard points at this Worker; channels are subscribed at
 * runtime when a broadcaster authorizes the bot.
 */
export class Bot extends Cloudflare.Worker<Bot>()(
  "TwitchBot",
  { main: import.meta.url },
  Effect.gen(function* () {
    const botUserId = yield* Config.String("TWITCH_BOT_USER_ID");
    const clientId = yield* Config.String("TWITCH_CLIENT_ID");

    const conduit = yield* Twitch.EventSub.Conduit("BotConduit");
    const eventsub = yield* Twitch.EventSub.consume(
      conduit,
      ["channel.chat.message", "channel.follow"],
      (event) => {
        switch (event.type) {
          case "channel.chat.message":
            return Effect.log(
              `[${event.payload.broadcaster_user_login}] ${event.payload.chatter_user_login}: ${event.payload.message.text}`,
            );
          case "channel.follow":
            return Effect.log(`${event.payload.user_login} followed ${event.payload.broadcaster_user_login}`);
        }
      },
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://worker");

        // Send the user to Twitch to grant every scope the consumed topics need.
        if (url.pathname === "/login") {
          return HttpServerResponse.redirect(
            Twitch.authorizeUrl({
              clientId,
              redirectUri: `${url.origin}/oauth/callback`,
              scopes: eventsub.scopes,
              state: crypto.randomUUID(),
            }),
          );
        }

        // Stand-in for an OAuth callback: a real bot exchanges `code` for
        // the broadcaster's token (granting `channel:bot`) and reads the
        // broadcaster id from it.
        if (url.pathname === "/oauth/callback") {
          const broadcasterId = url.searchParams.get("broadcaster_id");
          if (broadcasterId === null) {
            return HttpServerResponse.text("missing broadcaster_id", { status: 400 });
          }
          const chat = yield* eventsub.subscribe("channel.chat.message", {
            broadcaster_user_id: broadcasterId,
            user_id: botUserId,
          });
          const follows = yield* eventsub.subscribe("channel.follow", {
            broadcaster_user_id: broadcasterId,
            moderator_user_id: botUserId,
          });
          return yield* HttpServerResponse.json({ chat, follows });
        }

        if (url.pathname === "/unsubscribe" && request.method === "POST") {
          const id = url.searchParams.get("id");
          if (id === null) return HttpServerResponse.text("missing id", { status: 400 });
          yield* eventsub.unsubscribe(id);
          return HttpServerResponse.empty({ status: 204 });
        }

        return HttpServerResponse.text("Twitch bot", { status: 200 });
      }).pipe(
        Effect.catchTags({
          TwitchAppError: (error) =>
            Effect.succeed(HttpServerResponse.text(error.message, { status: 502 })),
          ConduitUnavailable: (error) =>
            Effect.succeed(HttpServerResponse.text(error.message, { status: 503 })),
        }),
      ),
    };
  }).pipe(Effect.provide(Twitch.EventSub.EventSubSourceLive)),
) {}

export default Bot;
