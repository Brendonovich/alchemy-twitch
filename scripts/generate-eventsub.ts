/**
 * Generates src/eventsub/schemas.ts, src/eventsub/subscriptions.ts and
 * test/fixtures/eventsub-examples.json from Twitch's EventSub reference
 * (https://dev.twitch.tv/docs/eventsub/reference/), using each type's latest
 * version.
 *
 *   node scripts/generate-eventsub.ts [--docs <dir of cached .md pages>]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const PAGES = [
  "automod",
  "channel",
  "channel-moderation",
  "channel-points",
  "charity",
  "chat",
  "conduit",
  "drop",
  "extension",
  "goal",
  "guest-star",
  "hype-train",
  "poll",
  "prediction",
  "stream",
  "user",
];

/** Types EventSub can't deliver over a conduit, which is the only transport this package uses. */
const SKIPPED: Record<string, string> = {
  "drop.entitlement.grant": "webhook-only and batched",
};

/** Hand-written condition checks the docs only describe in prose. */
const CONDITION_CHECKS: Record<string, string> = {
  "channel.raid": [
    "Schema.makeFilter(",
    "  (condition) =>",
    "    (condition.from_broadcaster_user_id === undefined) !==",
    "      (condition.to_broadcaster_user_id === undefined) ||",
    '    "set exactly one of from_broadcaster_user_id or to_broadcaster_user_id",',
    ")",
  ].join("\n"),
};

type Kind = "String" | "Integer" | "Number" | "Boolean" | "Object" | "Unknown";

interface Field {
  name: string;
  kind: Kind;
  array: boolean;
  nullable: boolean;
  optional: boolean;
  date: boolean;
  values: Array<string> | undefined;
  description: string;
  children: Map<string, Field>;
}

interface Section {
  title: string;
  description: string;
  type: string;
  version: string;
  body: string;
}

const docsArg = process.argv.indexOf("--docs");
const docsDir = docsArg === -1 ? undefined : process.argv[docsArg + 1];

const loadPage = async (page: string): Promise<string> => {
  if (docsDir !== undefined) return readFile(join(docsDir, page + ".md"), "utf8");
  const response = await fetch("https://dev.twitch.tv/docs/eventsub/reference/" + page + ".md");
  if (!response.ok) throw new Error("Fetching " + page + ": " + response.status);
  return response.text();
};

const sectionsOf = (markdown: string): Array<Section> =>
  markdown
    .split(/\n## (?=[^\n]*\{#)/)
    .slice(1)
    .flatMap((body) => {
      const type = body.match(/^- Type: `([^`]+)`/m)?.[1];
      const version = body.match(/^- Version: `([^`]+)`/m)?.[1];
      if (type === undefined || version === undefined) return [];
      const title = (body.split("\n")[0] ?? "").replace(/\s*\{#.*\}$/, "");
      const intro = (body.split("\n").slice(1).join("\n").trim().split(/\n\s*\n/)[0] ?? "")
        .replace(/\s+/g, " ")
        .trim();
      return [{ title: title.replace(/\s+V\d+$/, ""), description: intro, type, version, body }];
    });

const between = (text: string, start: string, end: string): string => {
  const from = text.indexOf(start);
  if (from === -1) return "";
  const to = text.indexOf(end, from + start.length);
  return text.slice(from + start.length, to === -1 ? undefined : to);
};

const FIELD = /^(\s*)- `([A-Za-z0-9_.]+)` — ([A-Za-z]+)(\[\])?(, Nullable)?(, \*\*Required\*\*)?(.*)$/;
const VALUE = /^\s*- `([^`]+)`/;

interface Line {
  path: string;
  kind: Kind;
  array: boolean;
  nullable: boolean;
  required: boolean;
  values: Array<string> | undefined;
  description: string;
}

const kindOf = (raw: string): Kind => {
  switch (raw) {
    case "String":
    case "Integer":
    case "Boolean":
    case "Object":
      return raw;
    case "Float":
    case "Number":
      return "Number";
    default:
      return "Unknown";
  }
};

/** The field bullets of a block, with "Possible values" and continuation lines attached. */
const parseLines = (block: string): Array<Line> => {
  const lines: Array<Line> = [];
  let inValues = false;
  for (const raw of block.split("\n")) {
    const field = raw.match(FIELD);
    if (field !== null) {
      lines.push({
        path: field[2] ?? "",
        kind: kindOf(field[3] ?? ""),
        array: field[4] !== undefined,
        nullable: field[5] !== undefined,
        required: field[6] !== undefined,
        values: undefined,
        description: (field[7] ?? "").replace(/^[.,]\s*/, ""),
      });
      inValues = false;
      continue;
    }
    const last = lines[lines.length - 1];
    if (last === undefined) continue;
    if (/^\s*Possible values:/.test(raw)) {
      inValues = true;
      last.values = [];
      continue;
    }
    const value = raw.match(VALUE);
    if (inValues && value !== null) {
      last.values?.push(value[1] ?? "");
      continue;
    }
    if (raw.trim().length > 0) inValues = false;
    last.description += " " + raw.trim();
  }
  return lines;
};

const newField = (name: string, kind: Kind): Field => ({
  name,
  kind,
  array: false,
  nullable: false,
  optional: false,
  date: false,
  values: undefined,
  description: "",
  children: new Map(),
});

/** Build the tree under `prefix` (e.g. "event") from dotted field paths. */
const treeOf = (lines: Array<Line>, prefix: string): Field => {
  const top = newField(prefix, "Object");
  for (const line of lines) {
    if (!line.path.startsWith(prefix + ".")) continue;
    const parts = line.path.slice(prefix.length + 1).split(".");
    let node = top;
    for (const part of parts.slice(0, -1)) {
      let child = node.children.get(part);
      if (child === undefined) {
        child = newField(part, "Object");
        node.children.set(part, child);
      }
      node = child;
    }
    const name = parts[parts.length - 1] ?? "";
    const field = node.children.get(name) ?? newField(name, line.kind);
    field.kind = line.kind;
    field.array = line.array;
    field.nullable = line.nullable;
    field.values = line.values !== undefined && line.values.length > 0 ? line.values : undefined;
    field.description = line.description;
    field.optional = /Included only if|only included|not included|Optional\./i.test(line.description);
    field.date =
      line.kind === "String" &&
      field.values === undefined &&
      (/_at$/.test(name) || /RFC ?3339/i.test(line.description));
    node.children.set(name, field);
  }
  return top;
};

const inferKind = (value: unknown): { kind: Kind; array: boolean } => {
  if (Array.isArray(value)) {
    const first = value.find((item) => item !== null);
    return { kind: first === undefined ? "Unknown" : inferKind(first).kind, array: true };
  }
  if (typeof value === "string") return { kind: "String", array: false };
  if (typeof value === "boolean") return { kind: "Boolean", array: false };
  if (typeof value === "number") return { kind: Number.isInteger(value) ? "Integer" : "Number", array: false };
  if (typeof value === "object" && value !== null) return { kind: "Object", array: false };
  return { kind: "Unknown", array: false };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Loosen a field to accept what Twitch's own example sends. */
const relaxValue = (field: Field, value: unknown): void => {
  if (value === null) {
    field.nullable = true;
    return;
  }
  if (field.array) {
    if (!Array.isArray(value)) return;
    for (const item of value) relaxItem(field, item);
    return;
  }
  relaxItem(field, value);
};

const relaxItem = (field: Field, value: unknown): void => {
  if (value === null) return;
  if (field.kind === "Integer" && typeof value === "number" && !Number.isInteger(value)) {
    field.kind = "Number";
  }
  if (field.kind === "Integer" && typeof value === "string") field.kind = "String";
  if (field.values !== undefined && typeof value === "string" && !field.values.includes(value)) {
    field.values.push(value);
  }
  if (field.date && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) {
    field.date = false;
  }
  if (field.kind === "Object" && isRecord(value)) relaxObject(field, value);
};

const relaxObject = (node: Field, value: Record<string, unknown>): void => {
  for (const child of node.children.values()) {
    if (!(child.name in value)) child.optional = true;
    else relaxValue(child, value[child.name]);
  }
  for (const [key, item] of Object.entries(value)) {
    if (node.children.has(key)) continue;
    const inferred = inferKind(item);
    const child = newField(key, inferred.kind);
    child.array = inferred.array;
    child.optional = true;
    child.nullable = item === null;
    node.children.set(key, child);
    relaxValue(child, item);
  }
};

const quote = (value: string) => JSON.stringify(value);

const indent = (text: string, depth: number) =>
  text
    .split("\n")
    .map((line, index) => (index === 0 ? line : "  ".repeat(depth) + line))
    .join("\n");

const baseSchema = (field: Field, depth: number): string => {
  switch (field.kind) {
    case "String":
      if (field.values !== undefined) {
        const inline = "OpenLiterals([" + field.values.map(quote).join(", ") + "])";
        if (inline.length + depth * 2 < 80) return inline;
        const pad = "  ".repeat(depth + 1);
        return (
          "OpenLiterals([\n" +
          field.values.map((value) => pad + quote(value) + ",").join("\n") +
          "\n" +
          "  ".repeat(depth) +
          "])"
        );
      }
      return field.date ? "Schema.DateFromString" : "Schema.String";
    case "Integer":
      return "Schema.Int";
    case "Number":
      return "Schema.Number";
    case "Boolean":
      return "Schema.Boolean";
    case "Object":
      return field.children.size === 0
        ? "Schema.Record(Schema.String, Schema.Unknown)"
        : structOf(field, depth);
    case "Unknown":
      return "Schema.Unknown";
  }
};

const schemaOf = (field: Field, depth: number): string => {
  let schema = baseSchema(field, depth);
  if (field.array) schema = "Schema.Array(" + schema + ")";
  if (field.nullable) return "Schema.optional(Schema.NullOr(" + schema + "))";
  if (field.optional) return "Schema.optional(" + schema + ")";
  return schema;
};

const key = (name: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quote(name));

const structOf = (node: Field, depth: number): string => {
  const fields = [...node.children.values()].map(
    (child) => "  ".repeat(depth + 1) + key(child.name) + ": " + indent(schemaOf(child, depth + 1), 0) + ",",
  );
  return "Schema.Struct({\n" + fields.join("\n") + "\n" + "  ".repeat(depth) + "})";
};

const pascal = (type: string) =>
  type
    .split(/[._]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

/**
 * The least-privileged scopes an app needs for a type: for "a or b", the
 * read scope matching the condition's role; for "a, b scopes", all of them.
 */
const scopesOf = (section: Section): Array<string> => {
  const authorization = between(section.body, "### Authorization", "\n### ");
  const appToken = authorization.slice(authorization.indexOf("app access token"));
  const granted = appToken.indexOf("must have been granted");
  if (granted === -1) return [];
  const scopes: Array<string> = [];
  let role = "broadcaster";
  for (const line of appToken.slice(granted).split("\n")) {
    const subject = line.match(/represented by the \*([a-z_]+)\*/);
    if (subject !== null) role = (subject[1] ?? "").startsWith("moderator") ? "moderator" : "broadcaster";
    const tokens = [...line.matchAll(/\*\*([a-z_:]+)\*\*/g)].map((match) => match[1] ?? "");
    if (tokens.length === 0) continue;
    if (/\*\* or \*\*|, or \*\*/.test(line)) {
      const preferred =
        tokens.find((token) => token.startsWith(role + ":read:")) ??
        tokens.find((token) => token.includes(":read:")) ??
        tokens[0];
      if (preferred !== undefined) scopes.push(preferred);
    } else {
      scopes.push(...tokens);
    }
  }
  return [...new Set(scopes)];
};

const examplesOf = (section: Section): Array<Record<string, unknown>> => {
  const examples: Array<Record<string, unknown>> = [];
  for (const block of section.body.split(/\n### /)) {
    if (!/^Event Payload Example/.test(block)) continue;
    for (const match of block.matchAll(/```json\n([\s\S]*?)```/g)) {
      const parsed: unknown = JSON.parse(match[1] ?? "");
      if (isRecord(parsed)) examples.push(parsed);
    }
  }
  return examples;
};

const requestConditionOf = (section: Section): Record<string, unknown> | undefined => {
  for (const block of section.body.split(/\n### /)) {
    if (!/^Subscription Request Body Example/.test(block)) continue;
    const match = block.match(/```json\n([\s\S]*?)```/);
    if (match === null) continue;
    const parsed: unknown = JSON.parse(match[1] ?? "");
    if (isRecord(parsed) && isRecord(parsed.condition)) return parsed.condition;
  }
  return undefined;
};

const versionRank = (version: string) => (/^\d+$/.test(version) ? Number(version) : 0);

const comment = (text: string, depth = 0) => {
  const pad = "  ".repeat(depth);
  const clean = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*/g, "").replace(/`/g, "'");
  const words = clean.split(/\s+/).filter(Boolean);
  const lines: Array<string> = [];
  let line = "";
  for (const word of words) {
    if ((pad + " * " + line + " " + word).length > 100 && line.length > 0) {
      lines.push(line);
      line = word;
    } else line = line.length === 0 ? word : line + " " + word;
  }
  if (line.length > 0) lines.push(line);
  if (lines.length === 1) return pad + "/** " + lines[0] + " */";
  return [pad + "/**", ...lines.map((entry) => pad + " * " + entry), pad + " */"].join("\n");
};

const main = async () => {
  const latest = new Map<string, Section>();
  for (const page of PAGES) {
    for (const section of sectionsOf(await loadPage(page))) {
      if (SKIPPED[section.type] !== undefined) continue;
      if (!/^- Transports: .*Conduit/m.test(section.body)) {
        throw new Error(section.type + " has no conduit transport; add it to SKIPPED");
      }
      const current = latest.get(section.type);
      if (current === undefined || versionRank(section.version) > versionRank(current.version)) {
        latest.set(section.type, section);
      }
    }
  }
  const sections = [...latest.values()].sort((a, b) => a.type.localeCompare(b.type));

  const schemaBlocks: Array<string> = [];
  const registryEntries: Array<string> = [];
  const fixtures: Array<unknown> = [];

  for (const section of sections) {
    const name = pascal(section.type);
    const request = between(section.body, "### Subscription Request Body\n", "\n### ");
    const payload = between(section.body, "### Event Payload\n", "\n### ");
    const examples = examplesOf(section);

    const condition = treeOf(parseLines(request), "condition");
    for (const field of condition.children.values()) {
      const line = parseLines(request).find((entry) => entry.path === "condition." + field.name);
      field.optional = line?.required !== true;
      field.nullable = false;
      field.date = false;
      field.values = undefined;
    }

    const event = treeOf(parseLines(payload), "event");
    for (const example of examples) {
      if (isRecord(example.event)) relaxObject(event, example.event);
    }

    const check = CONDITION_CHECKS[section.type];
    const conditionSchema =
      condition.children.size === 0
        ? "Schema.Struct({})"
        : structOf(condition, 0) + (check === undefined ? "" : ".check(\n  " + indent(check, 1) + ",\n)");
    const eventSchema = structOf(event, 0);

    schemaBlocks.push(
      [
        "/* " + section.type + " v" + section.version + " */",
        "",
        "export const " + name + "Condition = " + conditionSchema + ";",
        "",
        comment(section.description),
        "export const " + name + "Payload = " + eventSchema + ";",
      ].join("\n"),
    );

    const scopes = scopesOf(section);
    registryEntries.push(
      [
        comment(section.title + ": " + section.description, 1),
        "  " + quote(section.type) + ": define({",
        "    type: " + quote(section.type) + ",",
        "    version: " + quote(section.version) + ",",
        "    condition: Schemas." + name + "Condition,",
        "    payload: Schemas." + name + "Payload,",
        "    scopes: [" + scopes.map(quote).join(", ") + "],",
        "  }),",
      ].join("\n"),
    );

    for (const example of examples) {
      fixtures.push({
        type: section.type,
        version: section.version,
        condition: requestConditionOf(section),
        event: example.event,
      });
    }
  }

  const header = [
    "// Generated by scripts/generate-eventsub.ts from Twitch's EventSub reference:",
    "// https://dev.twitch.tv/docs/eventsub/reference/ . Do not edit by hand.",
    "",
  ].join("\n");

  await writeFile(
    join(root, "src/eventsub/schemas.ts"),
    header +
      [
        'import * as Schema from "effect/Schema";',
        "",
        'import { OpenLiterals } from "./OpenLiterals.ts";',
        "",
        "/**",
        " * EventSub conditions and event payloads, one pair per subscription type.",
        " * Field names are Twitch's wire names; timestamps decode to 'Date'. Fields",
        " * Twitch documents as enums accept any string, so new values still decode.",
        " */",
        "",
        schemaBlocks.join("\n\n"),
        "",
      ].join("\n"),
  );

  await writeFile(
    join(root, "src/eventsub/subscriptions.ts"),
    header +
      [
        'import { define } from "./definition.ts";',
        'import * as Schemas from "./schemas.ts";',
        "",
        "/** Every EventSub subscription type, at its latest version. */",
        "export const subscriptions = {",
        registryEntries.join("\n"),
        "} as const;",
        "",
      ].join("\n"),
  );

  await mkdir(join(root, "test/fixtures"), { recursive: true });
  await writeFile(
    join(root, "test/fixtures/eventsub-examples.json"),
    JSON.stringify(fixtures, null, 2) + "\n",
  );

  console.log("Generated " + sections.length + " subscription types, " + fixtures.length + " examples");
};

await main();
