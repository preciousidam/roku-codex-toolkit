import fs from "node:fs";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

export function compileSchema(schema) {
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}

export function assertSchemaValid(validate, value, label) {
  if (!validate(value)) {
    const details = validate.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`${label} does not match its JSON Schema: ${details}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [schemaPath, valuePath] = process.argv.slice(2);
  if (!schemaPath || !valuePath) {
    throw new Error("Usage: schema-validator.mjs SCHEMA.json VALUE.json");
  }
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const value = JSON.parse(fs.readFileSync(valuePath, "utf8"));
  assertSchemaValid(compileSchema(schema), value, valuePath);
}
