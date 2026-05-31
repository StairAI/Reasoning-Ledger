/**
 * codegen.mts
 *
 * Reads schema/records.schema.json and generates:
 *   - typescript-sdk/src/generated/records.ts  (Zod schemas + inferred TS types)
 *   - api-server/src/generated/records.ts      (same)
 *   - typescript-sdk/src/generated/version.ts  (current schema version)
 *   - api-server/src/generated/version.ts      (current schema version)
 *   - python-sdk/src/reasoning_ledger/generated/records.py  (Pydantic v2 models)
 *   - python-sdk/src/reasoning_ledger/generated/version.py  (current schema version)
 *
 * Usage:
 *   tsx scripts/codegen.mts            # generate all
 *   tsx scripts/codegen.mts --ts-only  # TypeScript only
 *   tsx scripts/codegen.mts --py-only  # Python only
 */

import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonSchemaToZod } from "json-schema-to-zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

const args = process.argv.slice(2);
const tsOnly = args.includes("--ts-only");
const pyOnly = args.includes("--py-only");
const generateTs = !pyOnly;
const generatePy = !tsOnly;

// ---------------------------------------------------------------------------
// Load schema
// ---------------------------------------------------------------------------
const schemaPath = resolve(rootDir, "schema/records.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as {
  version?: unknown;
  $defs: Record<string, unknown>;
};

if (typeof schema.version !== "string" || schema.version.length === 0) {
  throw new Error("schema/records.schema.json must define a non-empty top-level version string");
}

const schemaVersion = schema.version;

const baseRecord = schema.$defs.BaseRecord as
  | {
      properties?: {
        schema_version?: {
          examples?: unknown[];
        };
      };
    }
  | undefined;
const schemaVersionExamples = baseRecord?.properties?.schema_version?.examples ?? [];
if (!schemaVersionExamples.includes(schemaVersion)) {
  throw new Error(
    `BaseRecord.schema_version examples must include current schema version '${schemaVersion}'`,
  );
}

// Collect every version we still accept on the wire: the current live schema
// plus every snapshot under schema/history/<version>/records.schema.json.
// The api-server uses this list to reject records carrying unknown versions
// while keeping past versions valid during migrations.
const historyDir = resolve(rootDir, "schema/history");
const historyVersions: string[] = [];
for (const entry of readdirSync(historyDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const snapshotPath = resolve(historyDir, entry.name, "records.schema.json");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as { version?: unknown };
  if (typeof snapshot.version !== "string" || snapshot.version.length === 0) {
    throw new Error(`${snapshotPath} must define a non-empty top-level version string`);
  }
  if (snapshot.version !== entry.name) {
    throw new Error(
      `${snapshotPath} version '${snapshot.version}' does not match directory name '${entry.name}'`,
    );
  }
  historyVersions.push(snapshot.version);
}

const supportedVersions = [...new Set([...historyVersions, schemaVersion])].sort();

// ---------------------------------------------------------------------------
// TypeScript / Zod generation (via json-schema-to-zod)
// ---------------------------------------------------------------------------

/** Topological sort of $defs so referenced defs appear before dependents */
function topoSort(defs: Record<string, unknown>): string[] {
  const deps: Record<string, string[]> = {};
  const refPattern = /"\$ref":\s*"#\/\$defs\/([^"]+)"/g;

  for (const name of Object.keys(defs)) {
    const refs: string[] = [];
    const str = JSON.stringify(defs[name]);
    for (const m of str.matchAll(refPattern)) {
      const dep = m[1]!;
      if (dep !== name && dep in defs) refs.push(dep);
    }
    deps[name] = [...new Set(refs)];
  }

  const visited = new Set<string>();
  const order: string[] = [];

  function visit(name: string) {
    if (visited.has(name)) return;
    visited.add(name);
    for (const dep of deps[name] ?? []) visit(dep);
    order.push(name);
  }

  for (const name of Object.keys(defs)) visit(name);
  return order;
}

function generateTsFile(): string {
  const defs = schema.$defs;
  const order = topoSort(defs);

  const lines: string[] = [
    "// Code generated from schema/records.schema.json — do not edit manually.",
    "",
    'import { z } from "zod";',
    "",
  ];

  for (const name of order) {
    const def = defs[name]!;

    const code = jsonSchemaToZod(def as object, {
      parserOverride: (node) => {
        if (typeof node !== "object" || node === null) return;
        const s = node as Record<string, unknown>;

        // Replace $defs $refs with the variable name so schemas compose correctly
        if (typeof s.$ref === "string" && s.$ref.startsWith("#/$defs/")) {
          return s.$ref.replace("#/$defs/", "");
        }

        // Emit z.union for the behaviour discriminated union.
        // z.discriminatedUnion requires ZodObject members; our members are
        // z.intersection types (allOf composition), which Zod 4 does not
        // accept as discriminable. z.union provides the same runtime
        // validation with correct TypeScript inference.
        if (
          Array.isArray(s.oneOf) &&
          typeof s.discriminator === "object" &&
          s.discriminator !== null
        ) {
          const members = (s.oneOf as Array<{ $ref?: string }>)
            .map((m) =>
              typeof m.$ref === "string" && m.$ref.startsWith("#/$defs/")
                ? m.$ref.replace("#/$defs/", "")
                : null,
            )
            .filter(Boolean)
            .join(", ");
          return `z.union([${members}])`;
        }
      },
    });

    // jsonSchemaToZod returns a bare expression followed by a semicolon
    const expr = code.trim().replace(/;$/, "");
    lines.push(`export const ${name} = ${expr};`);
    lines.push(`export type ${name} = z.infer<typeof ${name}>;`);
    lines.push("");
  }

  return lines.join("\n");
}

function generateTsVersionFile(): string {
  const supportedLiteral = `[${supportedVersions.map((v) => JSON.stringify(v)).join(", ")}] as const`;
  return [
    "// Code generated from schema/records.schema.json — do not edit manually.",
    "",
    `export const SCHEMA_VERSION = ${JSON.stringify(schemaVersion)} as const;`,
    "",
    "// Every version the server still accepts on the wire: the current live",
    "// schema plus every snapshot under schema/history/. Drives server-side",
    "// version validation; lets old SDK clients keep submitting during migrations.",
    `export const SUPPORTED_SCHEMA_VERSIONS = ${supportedLiteral};`,
    "",
  ].join("\n");
}

if (generateTs) {
  const tsContent = generateTsFile();
  const tsVersionContent = generateTsVersionFile();

  const tsTargets = [
    resolve(rootDir, "typescript-sdk/src/generated/records.ts"),
    resolve(rootDir, "api-server/src/generated/records.ts"),
  ];

  for (const target of tsTargets) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, tsContent, "utf-8");
    console.log(`✓ Written ${target.replace(rootDir + "/", "")}`);
  }

  const tsVersionTargets = [
    resolve(rootDir, "typescript-sdk/src/generated/version.ts"),
    resolve(rootDir, "api-server/src/generated/version.ts"),
  ];

  for (const target of tsVersionTargets) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, tsVersionContent, "utf-8");
    console.log(`✓ Written ${target.replace(rootDir + "/", "")}`);
  }

  execFileSync(
    resolve(
      rootDir,
      "typescript-sdk/node_modules/.bin",
      process.platform === "win32" ? "oxfmt.cmd" : "oxfmt",
    ),
    [
      "--disable-nested-config",
      "--write",
      ...[...tsTargets, ...tsVersionTargets].map((target) => target.replace(rootDir + "/", "")),
    ],
    { cwd: rootDir, stdio: "inherit" },
  );
}

// ---------------------------------------------------------------------------
// Python / Pydantic generation via datamodel-code-generator
// ---------------------------------------------------------------------------

if (generatePy) {
  const pyOutput = resolve(rootDir, "python-sdk/src/reasoning_ledger/generated/records.py");
  const pyVersionOutput = resolve(rootDir, "python-sdk/src/reasoning_ledger/generated/version.py");
  mkdirSync(dirname(pyOutput), { recursive: true });

  const pySupportedLiteral = `(${supportedVersions.map((v) => JSON.stringify(v)).join(", ")}${supportedVersions.length === 1 ? "," : ""})`;
  writeFileSync(
    pyVersionOutput,
    [
      "# Code generated from schema/records.schema.json — do not edit manually.",
      "",
      `SCHEMA_VERSION = ${JSON.stringify(schemaVersion)}`,
      "",
      "# Every version the server still accepts on the wire: the current live",
      "# schema plus every snapshot under schema/history/. Drives server-side",
      "# version validation; lets old SDK clients keep submitting during migrations.",
      `SUPPORTED_SCHEMA_VERSIONS = ${pySupportedLiteral}`,
      "",
    ].join("\n"),
    "utf-8",
  );
  console.log(`✓ Written ${pyVersionOutput.replace(rootDir + "/", "")}`);

  // Write an __init__.py so the package is importable
  const initPath = resolve(dirname(pyOutput), "__init__.py");
  writeFileSync(
    initPath,
    "# Generated package — do not edit manually.\nfrom .records import *\nfrom .version import SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS\n",
    "utf-8",
  );

  try {
    execSync("uv tool install datamodel-code-generator", { stdio: "inherit" });
  } catch (err) {
    console.error("✗ datamodel-codegen failed. Make sure uv is installed");
    process.exit(1);
  }

  const cmd = [
    "datamodel-codegen",
    `--input ${schemaPath}`,
    "--input-file-type jsonschema",
    `--output ${pyOutput}`,
    "--output-model-type pydantic_v2.BaseModel",
    "--use-annotated",
    "--use-double-quotes",
    "--target-python-version 3.12",
    "--collapse-root-models",
    "--reuse-model",
    "--set-default-enum-member",
    "--field-constraints",
    "--disable-timestamp",
  ].join(" ");

  try {
    execSync(cmd, { stdio: "inherit" });
    console.log(`✓ Written ${pyOutput.replace(rootDir + "/", "")}`);
  } catch (err) {
    console.error("✗ datamodel-codegen failed. Make sure it is installed");
    process.exit(1);
  }
}
