import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { TOOLS, toolInputJsonSchema, toolsAsJsonSchemaList, generateTsApi } from "../tool-definitions.js";

const contracts = JSON.parse(fs.readFileSync(new URL("./fixtures/tool-contracts.json", import.meta.url), "utf8"));
const tools = toolsAsJsonSchemaList();
const byName = new Map(tools.map((tool) => [tool.name, tool.inputSchema]));
const validator = new AjvJsonSchemaValidator();

function sample(schema) {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf || schema.oneOf) return sample((schema.anyOf || schema.oneOf)[0]);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "string": return "x".repeat(Math.max(schema.minLength || 0, 1));
    case "number":
    case "integer": return schema.minimum ?? 0;
    case "boolean": return false;
    case "null": return null;
    case "array": return Array.from({ length: schema.minItems || 0 }, () => sample(schema.items));
    case "object": return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key, sample(value)]));
    default: throw new Error(`unhandled schema: ${JSON.stringify(schema)}`);
  }
}

test("all 28 tools retain their parameter and required-field contracts", () => {
  assert.deepEqual(tools.map((tool) => tool.name), contracts.map((tool) => tool.name));
  for (const contract of contracts) {
    const schema = byName.get(contract.name);
    assert.equal(schema.type, "object", contract.name);
    assert.deepEqual(Object.keys(schema.properties).sort(), contract.params, contract.name);
    assert.deepEqual([...(schema.required || [])].sort(), contract.required, contract.name);
    assert.equal(schema.$schema, undefined);
    assert.equal(schema.$ref, undefined);
    const shape = TOOLS.find((tool) => tool.name === contract.name).paramShape;
    for (const [key, field] of Object.entries(shape)) {
      assert(field._zod, `${contract.name}.${key} must use Zod 4`);
      assert.equal(schema.properties[key].description, field.description, `${contract.name}.${key}`);
    }
  }
});

test("every schema compiles and agrees with Zod on valid data and missing required fields", () => {
  for (const tool of TOOLS) {
    const schema = byName.get(tool.name);
    const validate = validator.getValidator(schema);
    const parse = z.object(tool.paramShape);
    const input = sample(schema);
    assert.equal(validate(input).valid, true, tool.name);
    assert.equal(parse.safeParse(input).success, true, tool.name);
    for (const key of schema.required || []) {
      const missing = { ...input };
      delete missing[key];
      assert.equal(validate(missing).valid, false, `${tool.name}.${key}`);
      assert.equal(parse.safeParse(missing).success, false, `${tool.name}.${key}`);
    }
  }
});

test("array lengths, numeric bounds and named-group constraints survive conversion", () => {
  const computer = validator.getValidator(byName.get("computer"));
  const valid = { action: "left_click", tabId: 1, coordinate: [2, 3] };
  assert(computer(valid).valid);
  for (const coordinate of [[1], [1, 2, 3], ["x", 2]]) {
    assert.equal(computer({ ...valid, coordinate }).valid, false);
  }
  assert.equal(computer({ ...valid, duration: 31 }).valid, false);
  assert.equal(computer({ ...valid, action: "not-an-action" }).valid, false);
  const create = validator.getValidator(byName.get("tabs_create_mcp"));
  assert(create({ groupName: "agent" }).valid);
  assert.equal(create({ groupName: "" }).valid, false);
  assert.equal(create({ groupName: "x".repeat(51) }).valid, false);
  assert.equal(create({ groupName: "agent", color: "invisible" }).valid, false);
  const close = validator.getValidator(byName.get("close_tabs"));
  assert(close({ tabIds: [1, 2] }).valid);
  assert.equal(close({ tabIds: [] }).valid, false);
  assert.equal(close({ tabIds: [1.5] }).valid, false);
});

test("form values and configuration resets preserve primitive unions and real null", () => {
  const form = validator.getValidator(byName.get("form_input"));
  for (const value of ["text", false, 42]) assert(form({ tabId: 1, ref: "ref_1", value }).valid);
  assert.equal(form({ tabId: 1, ref: "ref_1", value: {} }).valid, false);
  const config = validator.getValidator(byName.get("set_config"));
  for (const value of [null, true, 42, "natural"]) assert(config({ key: "humanize", value }).valid);
  assert.equal(config({ key: "humanize", value: [] }).valid, false);
  assert.equal(config({ key: "humanize" }).valid, false);
});

test("codemode and hybrid descriptions retain typed inputs instead of unknown", () => {
  const api = generateTsApi(tools, "chrome");
  assert.match(api, /declare const chrome:/);
  assert.match(api, /value: string \| boolean \| number;/);
  assert.match(api, /value: boolean \| number \| string \| null;/);
  assert.doesNotMatch(api, /type \w+Input = unknown/);
  assert.doesNotMatch(api, /:\s*unknown;/);
  for (const { name } of tools) assert(api.includes(`${name}: (input:`), name);
});

test("unsupported schemas fail instead of silently advertising unrestricted inputs", () => {
  assert.throws(() => toolInputJsonSchema({ paramShape: { unsupported: z.map(z.string(), z.number()) } }));
});
