import * as Schema from "effect/Schema";

/**
 * A string Twitch documents as one of `literals`. Decodes any string, so a
 * value Twitch adds later doesn't reject the whole event, while the type
 * still offers the documented values.
 */
export const OpenLiterals = <const Literals extends ReadonlyArray<string>>(
  _literals: Literals,
): Schema.Codec<Literals[number] | (string & {}), string, never, never> => Schema.String;
