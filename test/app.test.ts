import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";

import { TwitchApp, layer } from "../src/app.ts";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
}

const fakeTwitch = (respond: (seen: Seen, tokens: number) => Response) => {
  const seen: Array<Seen> = [];
  let tokens = 0;
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const entry = {
        method: request.method,
        url: request.url,
        authorization: request.headers["authorization"],
      };
      seen.push(entry);
      if (request.url === "https://id.twitch.tv/oauth2/token") {
        tokens += 1;
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            access_token: `app-token-${tokens}`,
            expires_in: 3600,
            token_type: "bearer",
          }),
        );
      }
      return HttpClientResponse.fromWeb(request, respond(entry, tokens));
    }),
  );
  return { seen, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

const credentials = { clientId: "client-id", clientSecret: Redacted.make("client-secret") };

const appWith = (http: Layer.Layer<HttpClient.HttpClient>) =>
  Effect.gen(function* () {
    return yield* TwitchApp;
  }).pipe(Effect.provide(layer(credentials).pipe(Layer.provide(http))));

describe("TwitchApp", () => {
  it.effect("fetches an app token once and reuses it", () =>
    Effect.gen(function* () {
      const twitch = fakeTwitch(() => Response.json({ data: [] }));
      const app = yield* appWith(twitch.layer);
      const first = yield* app.helix({ method: "GET", path: "/eventsub/conduits" });
      yield* app.helix({ method: "GET", path: "/eventsub/conduits" });
      expect(first).toEqual({ status: 200, body: { data: [] } });
      const tokenCalls = twitch.seen.filter((entry) => entry.url.includes("oauth2/token"));
      expect(tokenCalls).toHaveLength(1);
      const helixCalls = twitch.seen.filter((entry) => entry.url.includes("/helix/"));
      expect(helixCalls.map((entry) => entry.url)).toEqual([
        "https://api.twitch.tv/helix/eventsub/conduits",
        "https://api.twitch.tv/helix/eventsub/conduits",
      ]);
      expect(helixCalls.every((entry) => entry.authorization === "Bearer app-token-1")).toBe(true);
    }),
  );

  it.effect("refreshes the app token when Helix answers 401", () =>
    Effect.gen(function* () {
      const twitch = fakeTwitch((entry) =>
        entry.authorization === "Bearer app-token-1"
          ? Response.json({ message: "Invalid OAuth token" }, { status: 401 })
          : Response.json({ data: [{ id: "c", shard_count: 1 }] }),
      );
      const app = yield* appWith(twitch.layer);
      const reply = yield* app.helix({ method: "GET", path: "/eventsub/conduits" });
      expect(reply.status).toBe(200);
      expect(twitch.seen.filter((entry) => entry.url.includes("oauth2/token"))).toHaveLength(2);
    }),
  );

  it.effect("returns non-2xx Helix replies instead of failing", () =>
    Effect.gen(function* () {
      const twitch = fakeTwitch(() => Response.json({ message: "nope" }, { status: 409 }));
      const app = yield* appWith(twitch.layer);
      const reply = yield* app.helix({ method: "POST", path: "/eventsub/subscriptions", body: {} });
      expect(reply).toEqual({ status: 409, body: { message: "nope" } });
    }),
  );
});
