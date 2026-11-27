export interface AuthorizeUrlInput {
  readonly clientId: string;
  /** Must match a redirect URL registered on the app in the Twitch developer console. */
  readonly redirectUri: string;
  readonly scopes: Iterable<string>;
  /** @default "code" */
  readonly responseType?: "code" | "token";
  /** Echoed back to the redirect URI; use a fresh value per request to prevent CSRF. */
  readonly state?: string;
  /** Ask the user to re-approve even if they already authorized the app. */
  readonly forceVerify?: boolean;
  /** Defaults to `https://id.twitch.tv`. */
  readonly idBaseUrl?: string;
}

/**
 * The Twitch OAuth consent link for a user access token:
 * https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/
 *
 * ```ts
 * Twitch.authorizeUrl({ clientId, redirectUri, scopes: eventsub.scopes, state })
 * ```
 */
export const authorizeUrl = (input: AuthorizeUrlInput): string => {
  const base = (input.idBaseUrl ?? "https://id.twitch.tv").replace(/\/$/, "");
  const url = new URL(`${base}/oauth2/authorize`);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", input.responseType ?? "code");
  url.searchParams.set("scope", [...new Set(input.scopes)].sort().join(" "));
  if (input.state !== undefined) url.searchParams.set("state", input.state);
  if (input.forceVerify) url.searchParams.set("force_verify", "true");
  return url.toString();
};
