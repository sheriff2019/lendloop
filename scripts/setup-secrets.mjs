#!/usr/bin/env node
/**
 * Creates .env (for docker-compose) with fresh random secrets, and — with
 * --convex — copies the matching values into the Convex deployment's
 * environment. Never prints a secret. Safe to re-run: existing values are kept.
 *
 *   npm run setup:secrets              # write .env
 *   npm run setup:secrets -- --convex  # ...and set them in Convex too
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const GENERATED = ["N8N_ENCRYPTION_KEY", "CONVEX_TO_N8N_SECRET", "N8N_TO_CONVEX_SECRET"];

const source = existsSync(".env") ? ".env" : ".env.example";
const lines = readFileSync(source, "utf8").split("\n");
const values = {};
const out = lines.map((line) => {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) return line;
  let [, key, value] = m;
  if (GENERATED.includes(key) && value.trim() === "") {
    value = randomBytes(32).toString("hex");
    console.log(`  generated ${key}`);
  }
  values[key] = value;
  return `${key}=${value}`;
});
writeFileSync(".env", out.join("\n"), { mode: 0o600 });
console.log(`.env is ready (${source === ".env" ? "kept existing values" : "created from .env.example"}).`);

if (process.argv.includes("--convex")) {
  const tz = values.TIMEZONE || "UTC";
  const env = {
    CONVEX_TO_N8N_SECRET: values.CONVEX_TO_N8N_SECRET,
    N8N_TO_CONVEX_SECRET: values.N8N_TO_CONVEX_SECRET,
    N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL || "http://127.0.0.1:5678/webhook/lendloop-events",
    APP_TIMEZONE: tz,
  };
  for (const [key, value] of Object.entries(env)) {
    // execFileSync with an argument list: the secret never passes through a shell.
    execFileSync("npx", ["convex", "env", "set", key, value], { stdio: ["ignore", "ignore", "inherit"] });
    console.log(`  Convex: set ${key}`);
  }
}
