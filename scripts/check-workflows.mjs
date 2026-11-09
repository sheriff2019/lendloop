#!/usr/bin/env node
/**
 * Fails if anything that looks like a secret is in the exported n8n workflows
 * or the local credential file. Run in CI and before every commit:
 *   npm run check:workflows
 *
 * Rules: credentials may be referenced by id + name only; no field named like a
 * secret may hold a literal value; no long hex / base64 / provider-key strings.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIRS = ["n8n/workflows", "n8n/credentials"];
const SECRET_KEY = /(secret|password|passwd|token|api[_-]?key|private[_-]?key|authorization)/i;
const SUSPICIOUS = [
  [/\b(sk|pk|rk)_(test|live)_[0-9a-z]{8,}/i, "provider API key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/(?<![0-9a-f-])[0-9a-f]{32,}(?![0-9a-f-])/i, "long hex string (HMAC secret?)"],
  [/\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/])/, "long base64 string"],
  [/https?:\/\/[^\s/"']+:[^\s@"']+@/, "credentials inside a URL"],
];

const problems = [];

function walk(value, path, file) {
  if (typeof value === "string") {
    const last = path[path.length - 1] ?? "";
    const isCode = last === "jsCode" || last === "content"; // code / sticky notes: scanned for patterns only
    if (!isCode && SECRET_KEY.test(String(last)) && value !== "" && !value.startsWith("=")) {
      problems.push(`${file} › ${path.join(".")}: literal value in a secret-looking field`);
    }
    for (const [re, what] of SUSPICIOUS) {
      if (re.test(value)) problems.push(`${file} › ${path.join(".")}: ${what}`);
    }
    return;
  }
  if (Array.isArray(value)) return value.forEach((v, i) => walk(v, [...path, i], file));
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "credentials" && path.length > 0 && v && typeof v === "object") {
        for (const [type, ref] of Object.entries(v)) {
          const keys = Object.keys(ref ?? {}).sort().join(",");
          if (keys !== "id,name") problems.push(`${file} › ${[...path, k, type].join(".")}: credential reference must be {id, name} only`);
        }
        continue;
      }
      walk(v, [...path, k], file);
    }
  }
}

let files = 0;
for (const dir of DIRS) {
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const file = join(dir, name);
    walk(JSON.parse(readFileSync(file, "utf8")), [], file);
    files++;
  }
}

if (problems.length) {
  console.error(`✖ Possible secrets in n8n exports:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`✔ ${files} n8n files checked: no secrets found.`);
