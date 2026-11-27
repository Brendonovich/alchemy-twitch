import * as Effect from "effect/Effect";

import type { HelixCall, HelixReply, TwitchAppService } from "../src/app.ts";

export interface FakeShard {
  id: string;
  status: string;
  transport: { method: string; callback?: string; secret?: string };
}

export interface FakeSubscription {
  id: string;
  status: string;
  type: string;
  version: string;
  condition: Record<string, string>;
  transport: { method: string; conduit_id?: string };
}

const strings = (value: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
};

/**
 * In-memory Helix for conduits, shards and subscriptions. `onShardPatch`
 * decides the status Twitch reports after a shard update (the callback
 * verification outcome).
 */
export const makeFakeHelix = (
  options: {
    readonly shardStatusAfterPatch?: (shard: FakeShard) => string;
    readonly shardErrors?: ReadonlyArray<{ id: string; message: string; code: string }>;
  } = {},
) => {
  const calls: Array<HelixCall> = [];
  const conduits = new Map<string, { id: string; shards: Array<FakeShard> }>();
  const subscriptions: Array<FakeSubscription> = [];
  let next = 1;

  const reply = (status: number, body: unknown = null): HelixReply => ({ status, body });
  const shardsFor = (count: number, existing: Array<FakeShard> = []) =>
    Array.from(
      { length: count },
      (_, index) =>
        existing[index] ?? { id: String(index), status: "disabled", transport: { method: "webhook" } },
    );
  const publicShard = (shard: FakeShard) => ({
    id: shard.id,
    status: shard.status,
    transport:
      shard.transport.callback === undefined
        ? { method: shard.transport.method }
        : { method: shard.transport.method, callback: shard.transport.callback },
  });
  const conduitBody = (conduit: { id: string; shards: Array<FakeShard> }) => ({
    id: conduit.id,
    shard_count: conduit.shards.length,
  });
  const body = (call: HelixCall): Record<string, unknown> =>
    typeof call.body === "object" && call.body !== null ? { ...call.body } : {};
  const query = (call: HelixCall, key: string): string | undefined => {
    const value = call.query?.[key];
    return typeof value === "string" ? value : value?.[0];
  };

  const handle = (call: HelixCall): HelixReply => {
    const key = `${call.method} ${call.path}`;
    switch (key) {
      case "GET /eventsub/conduits":
        return reply(200, { data: [...conduits.values()].map(conduitBody) });
      case "POST /eventsub/conduits": {
        const id = `conduit-${next++}`;
        const count = Number(body(call).shard_count);
        const conduit = { id, shards: shardsFor(count) };
        conduits.set(id, conduit);
        return reply(200, { data: [conduitBody(conduit)] });
      }
      case "PATCH /eventsub/conduits": {
        const input = body(call);
        const conduit = conduits.get(String(input.id));
        if (conduit === undefined) return reply(404, { message: "conduit not found" });
        conduit.shards = shardsFor(Number(input.shard_count), conduit.shards);
        return reply(200, { data: [conduitBody(conduit)] });
      }
      case "DELETE /eventsub/conduits": {
        const id = query(call, "id") ?? "";
        if (!conduits.delete(id)) return reply(404, { message: "conduit not found" });
        return reply(204);
      }
      case "GET /eventsub/conduits/shards": {
        const conduit = conduits.get(query(call, "conduit_id") ?? "");
        if (conduit === undefined) return reply(404, { message: "conduit not found" });
        return reply(200, { data: conduit.shards.map(publicShard), pagination: {} });
      }
      case "PATCH /eventsub/conduits/shards": {
        const input = body(call);
        const conduit = conduits.get(String(input.conduit_id));
        if (conduit === undefined) return reply(404, { message: "conduit not found" });
        if (options.shardErrors !== undefined) {
          return reply(202, { data: [], errors: options.shardErrors });
        }
        const updates: Array<unknown> = Array.isArray(input.shards) ? input.shards : [];
        const data: Array<ReturnType<typeof publicShard>> = [];
        for (const update of updates) {
          const fields = strings(update);
          const shard = conduit.shards.find((candidate) => candidate.id === fields.id);
          if (shard === undefined) continue;
          const transport = strings(
            typeof update === "object" && update !== null && "transport" in update
              ? update.transport
              : undefined,
          );
          shard.transport = {
            method: transport.method ?? "",
            ...(transport.callback === undefined ? {} : { callback: transport.callback }),
            ...(transport.secret === undefined ? {} : { secret: transport.secret }),
          };
          shard.status = "webhook_callback_verification_pending";
          data.push(publicShard(shard));
          shard.status = options.shardStatusAfterPatch?.(shard) ?? "enabled";
        }
        return reply(202, { data, errors: [] });
      }
      case "POST /eventsub/subscriptions": {
        const input = body(call);
        const transportFields = strings(input.transport);
        const transport: FakeSubscription["transport"] =
          transportFields.conduit_id === undefined
            ? { method: transportFields.method ?? "" }
            : { method: transportFields.method ?? "", conduit_id: transportFields.conduit_id };
        const condition = strings(input.condition);
        const duplicate = subscriptions.find(
          (existing) =>
            existing.type === input.type &&
            existing.transport.conduit_id === transport.conduit_id &&
            JSON.stringify(existing.condition) === JSON.stringify(condition),
        );
        if (duplicate !== undefined) {
          return reply(409, { error: "Conflict", status: 409, message: "subscription already exists" });
        }
        const created: FakeSubscription = {
          id: `sub-${next++}`,
          status: "enabled",
          type: String(input.type),
          version: String(input.version),
          condition,
          transport,
        };
        subscriptions.push(created);
        return reply(202, { data: [created], total: subscriptions.length });
      }
      case "GET /eventsub/subscriptions": {
        const type = query(call, "type");
        return reply(200, {
          data: subscriptions.filter((subscription) => type === undefined || subscription.type === type),
          pagination: {},
        });
      }
      case "DELETE /eventsub/subscriptions": {
        const id = query(call, "id");
        const index = subscriptions.findIndex((subscription) => subscription.id === id);
        if (index === -1) return reply(404, { message: "subscription not found" });
        subscriptions.splice(index, 1);
        return reply(204);
      }
      default:
        return reply(404, { message: `no fake for ${key}` });
    }
  };

  const app: TwitchAppService = {
    helix: (call) =>
      Effect.sync(() => {
        calls.push(call);
        return handle(call);
      }),
  };

  return { app, calls, conduits, subscriptions };
};
