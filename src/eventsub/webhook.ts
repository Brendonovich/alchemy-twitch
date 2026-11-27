import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Twitch EventSub webhook messages:
 * https://dev.twitch.tv/docs/eventsub/handling-webhook-events/
 *
 * The signature is HMAC-SHA256 over `message id + timestamp + raw body`
 * with the subscription (shard) secret. Only Web Crypto is used, so this
 * runs unchanged in a Worker.
 */

export const MESSAGE_ID_HEADER = "twitch-eventsub-message-id";
export const MESSAGE_TIMESTAMP_HEADER = "twitch-eventsub-message-timestamp";
export const MESSAGE_SIGNATURE_HEADER = "twitch-eventsub-message-signature";
export const MESSAGE_TYPE_HEADER = "twitch-eventsub-message-type";

/** Twitch tells receivers to reject messages older than ten minutes. */
export const DEFAULT_TOLERANCE_MS = 10 * 60 * 1000;

export type WebhookVerificationCode =
  | "missing-header"
  | "invalid-timestamp"
  | "timestamp-out-of-window"
  | "invalid-signature";

export class WebhookVerificationError extends Data.TaggedError("WebhookVerificationError")<{
  readonly code: WebhookVerificationCode;
  readonly reason: string;
}> {
  override get message() {
    return this.reason;
  }
}

export class WebhookPayloadError extends Data.TaggedError("WebhookPayloadError")<{
  readonly reason: string;
}> {
  override get message() {
    return this.reason;
  }
}

/** Headers by name, matched case-insensitively. */
export type WebhookHeaders = Readonly<Record<string, string | undefined>>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const header = (headers: WebhookHeaders, name: string): string | undefined => {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
};

const toBytes = (body: string | Uint8Array): Uint8Array =>
  typeof body === "string" ? encoder.encode(body) : body;

const signedMessage = (messageId: string, timestamp: string, body: Uint8Array): Uint8Array => {
  const prefix = encoder.encode(messageId + timestamp);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);
  return message;
};

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const fromHex = (value: string): Uint8Array | undefined => {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) return undefined;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
};

const hmac = (secret: string, message: Uint8Array): Effect.Effect<Uint8Array> =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  });

/** The `sha256=<hex>` value Twitch sends in its signature header. */
export const computeSignature = (input: {
  readonly secret: string;
  readonly messageId: string;
  readonly timestamp: string;
  readonly body: string | Uint8Array;
}): Effect.Effect<string> =>
  Effect.map(
    hmac(input.secret, signedMessage(input.messageId, input.timestamp, toBytes(input.body))),
    (signature) => `sha256=${toHex(signature)}`,
  );

export interface VerifyInput {
  readonly headers: WebhookHeaders;
  /** The raw body, before any parsing. */
  readonly body: string | Uint8Array;
  readonly secret: string;
  readonly now?: number;
  readonly toleranceMs?: number;
}

const reject = (code: WebhookVerificationCode, reason: string) =>
  Effect.fail(new WebhookVerificationError({ code, reason }));

/** Check the headers, the replay window and the HMAC of the raw body. */
export const verifyWebhook = (input: VerifyInput): Effect.Effect<void, WebhookVerificationError> =>
  Effect.gen(function* () {
    const messageId = header(input.headers, MESSAGE_ID_HEADER);
    const timestamp = header(input.headers, MESSAGE_TIMESTAMP_HEADER);
    const signature = header(input.headers, MESSAGE_SIGNATURE_HEADER);
    if (!messageId) return yield* reject("missing-header", `Missing ${MESSAGE_ID_HEADER}`);
    if (!timestamp) return yield* reject("missing-header", `Missing ${MESSAGE_TIMESTAMP_HEADER}`);
    if (!signature) return yield* reject("missing-header", `Missing ${MESSAGE_SIGNATURE_HEADER}`);

    const sentAt = Date.parse(timestamp);
    if (Number.isNaN(sentAt)) {
      return yield* reject("invalid-timestamp", `${MESSAGE_TIMESTAMP_HEADER} is not a timestamp`);
    }
    const now = input.now ?? Date.now();
    if (Math.abs(now - sentAt) > (input.toleranceMs ?? DEFAULT_TOLERANCE_MS)) {
      return yield* reject("timestamp-out-of-window", "Message is outside the ten-minute window");
    }

    const provided = signature.startsWith("sha256=") ? fromHex(signature.slice(7)) : undefined;
    if (provided === undefined) {
      return yield* reject("invalid-signature", `${MESSAGE_SIGNATURE_HEADER} is malformed`);
    }
    const expected = yield* hmac(
      input.secret,
      signedMessage(messageId, timestamp, toBytes(input.body)),
    );
    if (!constantTimeEqual(expected, provided)) {
      return yield* reject("invalid-signature", "Signature does not match the body");
    }
  });

export const WebhookSubscription = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  type: Schema.String,
  version: Schema.String,
  condition: Schema.Record(Schema.String, Schema.String),
  created_at: Schema.optional(Schema.DateFromString),
  transport: Schema.optional(
    Schema.Struct({
      method: Schema.String,
      callback: Schema.optional(Schema.String),
      conduit_id: Schema.optional(Schema.String),
      session_id: Schema.optional(Schema.String),
    }),
  ),
  cost: Schema.optional(Schema.Number),
});
export type WebhookSubscription = Schema.Schema.Type<typeof WebhookSubscription>;

const Metadata = <Type extends string>(type: Type) =>
  Schema.Struct({
    message_id: Schema.String,
    message_type: Schema.Literal(type),
    message_timestamp: Schema.DateFromString,
  });

/** The webhook envelope, discriminated by `metadata.message_type`. */
export const WebhookMessage = Schema.Union([
  Schema.Struct({
    metadata: Metadata("webhook_callback_verification"),
    payload: Schema.Struct({ subscription: WebhookSubscription, challenge: Schema.String }),
  }),
  Schema.Struct({
    metadata: Metadata("notification"),
    payload: Schema.Struct({ subscription: WebhookSubscription, event: Schema.Unknown }),
  }),
  Schema.Struct({
    metadata: Metadata("revocation"),
    payload: Schema.Struct({ subscription: WebhookSubscription }),
  }),
]);
export type WebhookMessage = Schema.Schema.Type<typeof WebhookMessage>;

/** A verified delivery whose event payload hasn't been decoded yet. */
export type WebhookDelivery =
  | {
      readonly _tag: "verification";
      readonly challenge: string;
      readonly subscription: WebhookSubscription;
    }
  | {
      readonly _tag: "notification";
      readonly messageId: string;
      readonly messageTimestamp: Date;
      readonly receivedAt: Date;
      readonly subscription: WebhookSubscription;
      readonly event: unknown;
    }
  | {
      readonly _tag: "revocation";
      readonly subscription: WebhookSubscription;
    };

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));

const decodeMessage = Schema.decodeUnknownEffect(WebhookMessage);

// Webhook and conduit deliveries put metadata in headers and send
// `{ subscription, event | challenge }`; the WebSocket transport wraps the
// same payload as `{ metadata, payload }`. Support both, preferring the
// signed headers when they are present.
const WebhookBody = Schema.Struct({
  subscription: WebhookSubscription,
  challenge: Schema.optional(Schema.String),
  event: Schema.optional(Schema.Unknown),
});

const decodeWebhookBody = Schema.decodeUnknownEffect(WebhookBody);

const payloadError = (cause: { readonly message: string }) =>
  new WebhookPayloadError({ reason: cause.message });

/**
 * Verify one delivery and decode its envelope. Metadata comes from the signed
 * headers for webhooks and conduits; WebSocket-style envelopes fall back to
 * the body metadata.
 */
export const decodeWebhook = (
  input: VerifyInput,
): Effect.Effect<WebhookDelivery, WebhookVerificationError | WebhookPayloadError> =>
  Effect.gen(function* () {
    yield* verifyWebhook(input);
    const text = typeof input.body === "string" ? input.body : decoder.decode(input.body);
    const json = yield* decodeJson(text).pipe(Effect.mapError(payloadError));
    const messageType = header(input.headers, MESSAGE_TYPE_HEADER);
    // WebSocket envelopes carry their own metadata even when a message-type header is present.
    const isEnvelope =
      typeof json === "object" && json !== null && "metadata" in json && "payload" in json;

    if (!isEnvelope && messageType !== undefined) {
      const body = yield* decodeWebhookBody(json).pipe(Effect.mapError(payloadError));
      switch (messageType) {
        case "webhook_callback_verification":
          return {
            _tag: "verification" as const,
            challenge: body.challenge ?? "",
            subscription: body.subscription,
          };
        case "notification":
          return {
            _tag: "notification" as const,
            messageId: header(input.headers, MESSAGE_ID_HEADER) ?? "",
            messageTimestamp: new Date(header(input.headers, MESSAGE_TIMESTAMP_HEADER) ?? ""),
            receivedAt: new Date(input.now ?? Date.now()),
            subscription: body.subscription,
            event: body.event,
          };
        case "revocation":
          return { _tag: "revocation" as const, subscription: body.subscription };
        default:
          return yield* new WebhookPayloadError({
            reason: `Unknown ${MESSAGE_TYPE_HEADER}: ${messageType}`,
          });
      }
    }

    const message = yield* decodeMessage(json).pipe(Effect.mapError(payloadError));
    switch (message.metadata.message_type) {
      case "webhook_callback_verification":
        return {
          _tag: "verification" as const,
          challenge: "challenge" in message.payload ? message.payload.challenge : "",
          subscription: message.payload.subscription,
        };
      case "notification":
        return {
          _tag: "notification" as const,
          messageId: message.metadata.message_id,
          messageTimestamp: message.metadata.message_timestamp,
          receivedAt: new Date(input.now ?? Date.now()),
          subscription: message.payload.subscription,
          event: "event" in message.payload ? message.payload.event : undefined,
        };
      case "revocation":
        return { _tag: "revocation" as const, subscription: message.payload.subscription };
    }
  });
