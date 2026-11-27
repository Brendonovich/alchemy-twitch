import { describe, expect, it } from "@effect/vitest";

import { scopesFor } from "../src/eventsub/registry.ts";
import { authorizeUrl } from "../src/oauth.ts";

describe("OAuth authorize URL", () => {
  it("collects, deduplicates and sorts the scopes of the listed types", () => {
    expect(
      scopesFor(["stream.online", "channel.subscribe", "channel.subscription.gift", "channel.chat.message"]),
    ).toEqual(["channel:read:subscriptions", "user:read:chat"]);
    expect(scopesFor(["stream.online"])).toEqual([]);
  });

  it("builds Twitch's authorization code link", () => {
    const url = new URL(
      authorizeUrl({
        clientId: "client-1",
        redirectUri: "https://bot.example.com/oauth/callback",
        scopes: ["user:read:chat", "channel:bot", "user:read:chat"],
        state: "s-1",
        forceVerify: true,
      }),
    );
    expect(url.origin + url.pathname).toBe("https://id.twitch.tv/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client-1",
      redirect_uri: "https://bot.example.com/oauth/callback",
      response_type: "code",
      scope: "channel:bot user:read:chat",
      state: "s-1",
      force_verify: "true",
    });
  });

  it("omits optional parameters", () => {
    const url = new URL(
      authorizeUrl({ clientId: "c", redirectUri: "http://localhost/cb", scopes: [], idBaseUrl: "http://id.test/" }),
    );
    expect(url.origin).toBe("http://id.test");
    expect([...url.searchParams.keys()]).toEqual(["client_id", "redirect_uri", "response_type", "scope"]);
  });
});
