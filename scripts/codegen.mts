/**
 * codegen.mts
 *
 * Reads schema/records.schema.json and generates:
 *   - typescript-sdk/src/generated/records.ts  (Zod schemas + inferred TS types)
 *   - api-server/src/generated/records.ts      (same)
 *   - python-sdk/src/python_sdk/generated/records.py  (Pydantic v2 models)
 *
 * Usage:
 *   tsx scripts/codegen.mts            # generate all
 *   tsx scripts/codegen.mts --ts-only  # TypeScript only
 *   tsx scripts/codegen.mts --py-only  # Python only
 */

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  $defs: Record<string, unknown>;
};

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

        // Emit z.discriminatedUnion when the JSON Schema discriminator is present
        if (
          Array.isArray(s.oneOf) &&
          typeof s.discriminator === "object" &&
          s.discriminator !== null
        ) {
          const disc = s.discriminator as { propertyName: string };
          const members = (s.oneOf as Array<{ $ref?: string }>)
            .map((m) =>
              typeof m.$ref === "string" && m.$ref.startsWith("#/$defs/")
                ? m.$ref.replace("#/$defs/", "")
                : null,
            )
            .filter(Boolean)
            .join(", ");
          return `z.discriminatedUnion(${JSON.stringify(disc.propertyName)}, [${members}])`;
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

if (generateTs) {
  const tsContent = generateTsFile();

  const tsTargets = [
    resolve(rootDir, "typescript-sdk/src/generated/records.ts"),
    resolve(rootDir, "api-server/src/generated/records.ts"),
  ];

  for (const target of tsTargets) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, tsContent, "utf-8");
    console.log(`✓ Written ${target.replace(rootDir + "/", "")}`);
  }
}

// ---------------------------------------------------------------------------
// Python / Pydantic generation via datamodel-code-generator
// ---------------------------------------------------------------------------

if (generatePy) {
  const pyOutput = resolve(rootDir, "python-sdk/src/reasoning_ledger_sdk/generated/records.py");
  mkdirSync(dirname(pyOutput), { recursive: true });

  // Write an __init__.py so the package is importable
  const initPath = resolve(dirname(pyOutput), "__init__.py");
  try {
    writeFileSync(
      initPath,
      "# Generated package — do not edit manually.\nfrom .records import *\n",
      { flag: "wx" }, // only create if not exists
    );
  } catch {
    // already exists
  }

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
