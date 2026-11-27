import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Twitch from "../src/index.ts";
import { Bot } from "./bot-worker.ts";

/**
 * Example stack. Needs TWITCH_CLIENT_ID,
 * TWITCH_CLIENT_SECRET and TWITCH_BOT_USER_ID in the environment.
 */
export default Alchemy.Stack(
  "TwitchBotExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Twitch.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const bot = yield* Bot;
    return { url: bot.url };
  }),
);
