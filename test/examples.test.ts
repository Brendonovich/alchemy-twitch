import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildCondition,
  decodeEvent,
  isSubscriptionType,
  subscriptions,
  type ConditionOf,
  type SubscriptionType,
} from "../src/eventsub/registry.ts";

interface Example {
  readonly type: string;
  readonly version: string;
  readonly condition?: Record<string, string>;
  readonly event: unknown;
}

const all: ReadonlyArray<Example> = JSON.parse(
  readFileSync(fileURLToPath(import.meta.resolve("./fixtures/eventsub-examples.json")), "utf8"),
);

describe("Twitch's documented examples", () => {
  it("cover every subscription type", () => {
    expect(new Set(all.map((example) => example.type))).toEqual(new Set(Object.keys(subscriptions)));
  });

  for (const example of all) {
    it.effect(`decodes ${example.type} v${example.version}`, () =>
      Effect.gen(function* () {
        if (!isSubscriptionType(example.type)) return yield* Effect.die(`unknown ${example.type}`);
        const type: SubscriptionType = example.type;
        expect(subscriptions[type].version).toBe(example.version);
        const event = yield* decodeEvent(type, example.event);
        expect(event.type).toBe(type);
        if (example.condition !== undefined) {
          const condition = example.condition as ConditionOf<typeof type>;
          expect(buildCondition(type, condition)).toEqual(example.condition);
        }
      }),
    );
  }
});
