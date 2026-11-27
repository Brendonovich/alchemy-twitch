import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

/** A failed Twitch app call. `status` is 0 when Twitch never answered. */
export class TwitchAppError extends Data.TaggedError("TwitchAppError")<{
  readonly operation: string;
  readonly status: number;
  readonly message: string;
  readonly body?: unknown;
}> {}

export interface TwitchAppCredentials {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  /** Defaults to `https://api.twitch.tv`. */
  readonly apiBaseUrl?: string;
  /** Defaults to `https://id.twitch.tv`. */
  readonly idBaseUrl?: string;
}

export type HelixMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface HelixCall {
  readonly method: HelixMethod;
  /** Path under `/helix`, e.g. `/eventsub/conduits`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | ReadonlyArray<string>>>;
  readonly body?: unknown;
}

export interface HelixReply {
  readonly status: number;
  readonly body: unknown;
}

export interface TwitchAppService {
  /**
   * A Helix call with the app access token. Non-2xx responses are returned,
   * not raised, so callers can treat 404/409 as outcomes.
   */
  readonly helix: (call: HelixCall) => Effect.Effect<HelixReply, TwitchAppError>;
}

/**
 * Helix client authenticated as the Twitch application (client-credentials
 * grant). EventSub conduits and conduit subscriptions require an app token.
 * The token is cached until shortly before it expires and refreshed when
 * Twitch answers 401.
 */
export class TwitchApp extends Context.Service<TwitchApp, TwitchAppService>()(
  "Ballast/Alchemy/TwitchApp",
) {}

/** `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`. */
export const credentialsConfig: Config.Config<TwitchAppCredentials> = Config.all({
  clientId: Config.String("TWITCH_CLIENT_ID"),
  clientSecret: Config.Redacted("TWITCH_CLIENT_SECRET"),
});

const ErrorBody = Schema.Struct({ message: Schema.optional(Schema.String) });

/** Twitch's error message from a Helix body, when it sent one. */
export const errorMessage = (body: unknown, fallback: string): string => {
  const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(ErrorBody)(body));
  const message = parsed?.message?.trim();
  return message === undefined || message.length === 0 ? fallback : message;
};

const EXPIRY_MARGIN_MS = 60_000;

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
});

interface AppToken {
  readonly accessToken: string;
  readonly clientId: string;
  readonly expiresAt: number;
}

/**
 * Build the client. Credentials are an effect so a provider layer can read
 * them lazily (a stack without Twitch resources never needs them) while a
 * Worker reads them during init, where Alchemy binds them onto the Worker.
 */
export const make = (
  credentials: Effect.Effect<TwitchAppCredentials, TwitchAppError>,
): Effect.Effect<TwitchAppService, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const resolved = yield* Effect.cached(credentials);
    let cached: AppToken | undefined;

    const transportError = (operation: string) => (cause: { readonly message: string }) =>
      new TwitchAppError({ operation, status: 0, message: cause.message });

    const readBody = (response: { readonly text: Effect.Effect<string, unknown> }) =>
      response.text.pipe(
        Effect.orElseSucceed(() => ""),
        Effect.map((text): unknown => {
          if (text.trim().length === 0) return null;
          try {
            return JSON.parse(text);
          } catch {
            return text;
          }
        }),
      );

    const fetchToken = Effect.gen(function* () {
      const creds = yield* resolved;
      const idBase = (creds.idBaseUrl ?? "https://id.twitch.tv").replace(/\/$/, "");
      const response = yield* http
        .execute(
          HttpClientRequest.post(`${idBase}/oauth2/token`).pipe(
            HttpClientRequest.setHeader("Accept", "application/json"),
            HttpClientRequest.bodyUrlParams({
              client_id: creds.clientId,
              client_secret: Redacted.value(creds.clientSecret),
              grant_type: "client_credentials",
            }),
          ),
        )
        .pipe(Effect.mapError(transportError("clientCredentials")));
      const body = yield* readBody(response);
      if (response.status < 200 || response.status >= 300) {
        return yield* new TwitchAppError({
          operation: "clientCredentials",
          status: response.status,
          message: errorMessage(body, `Twitch token request failed (${response.status})`),
          body,
        });
      }
      const token = yield* Schema.decodeUnknownEffect(TokenResponse)(body).pipe(
        Effect.mapError(
          (cause) =>
            new TwitchAppError({
              operation: "clientCredentials",
              status: response.status,
              message: `Unexpected token response: ${cause.message}`,
            }),
        ),
      );
      const fresh: AppToken = {
        accessToken: token.access_token,
        clientId: creds.clientId,
        expiresAt: Date.now() + token.expires_in * 1_000,
      };
      cached = fresh;
      return fresh;
    });

    const getToken = Effect.suspend(() =>
      cached !== undefined && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()
        ? Effect.succeed(cached)
        : fetchToken,
    );

    const send = (call: HelixCall, token: AppToken) =>
      Effect.gen(function* () {
        const creds = yield* resolved;
        const apiBase = (creds.apiBaseUrl ?? "https://api.twitch.tv").replace(/\/$/, "");
        const url = new URL(`${apiBase}/helix${call.path}`);
        for (const [key, value] of Object.entries(call.query ?? {})) {
          if (typeof value === "string") url.searchParams.append(key, value);
          else for (const item of value) url.searchParams.append(key, item);
        }
        let request = HttpClientRequest.make(call.method)(url.toString()).pipe(
          HttpClientRequest.setHeaders({
            "Client-Id": token.clientId,
            Authorization: `Bearer ${token.accessToken}`,
            Accept: "application/json",
          }),
        );
        if (call.body !== undefined) request = HttpClientRequest.bodyJsonUnsafe(request, call.body);
        const response = yield* http
          .execute(request)
          .pipe(Effect.mapError(transportError(`${call.method} ${call.path}`)));
        return { status: response.status, body: yield* readBody(response) };
      });

    const helix = (call: HelixCall): Effect.Effect<HelixReply, TwitchAppError> =>
      Effect.gen(function* () {
        const reply = yield* send(call, yield* getToken);
        if (reply.status !== 401) return reply;
        cached = undefined;
        return yield* send(call, yield* fetchToken);
      });

    return { helix };
  });

const configCredentials = Effect.gen(function* () {
  return yield* credentialsConfig;
}).pipe(
  Effect.mapError(
    (error: Config.ConfigError) =>
      new TwitchAppError({ operation: "config", status: 0, message: error.message }),
  ),
);

/** Reads `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` on first use. Needs an `HttpClient`. */
export const layerConfig: Layer.Layer<TwitchApp, never, HttpClient.HttpClient> = Layer.effect(
  TwitchApp,
  make(configCredentials),
);

/** {@link layerConfig} over `fetch`. */
export const layerConfigFetch: Layer.Layer<TwitchApp> = layerConfig.pipe(
  Layer.provide(FetchHttpClient.layer),
);

/** A client with explicit credentials. Needs an `HttpClient`. */
export const layer = (
  credentials: TwitchAppCredentials,
): Layer.Layer<TwitchApp, never, HttpClient.HttpClient> =>
  Layer.effect(TwitchApp, make(Effect.succeed(credentials)));
