// Shared test helpers: scripted prompt answers and output capture.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each step: [kind, message regexp, answer]. The answer may be a function of the
// prompt options, to inspect what was offered.
export function scripted(steps) {
  const take = (kind) => async (opts) => {
    const step = steps.shift();
    assert.ok(step, `unexpected ${kind} prompt: "${opts.message}"`);
    assert.equal(kind, step[0], `expected a ${step[0]} prompt, got ${kind}: "${opts.message}"`);
    assert.match(opts.message, step[1]);
    return typeof step[2] === "function" ? step[2](opts) : step[2];
  };
  return {
    select: take("select"),
    input: take("input"),
    password: take("password"),
    confirm: take("confirm"),
    checkbox: take("checkbox"),
    remaining: steps,
  };
}

// Collects what the code under test prints.
export async function captured(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

// A .env with database settings next to secrets that must never leak.
export const ENV = `
APP_NAME=Shop
APP_KEY=base64:SUPERSECRETAPPKEY=
STRIPE_SECRET=sk_live_dont_touch
export DB_CONNECTION=mysql
DB_HOST=127.0.0.1   # local
DB_PORT=3307
DB_DATABASE="shop_prod"
DB_USERNAME='shop'
DB_PASSWORD="p\\"a#ss word"
MAIL_PASSWORD=also-secret
`;

// A minimal Laravel 11 app with uploads, logs and caches.
export async function laravelFixture() {
  const dir = await mkdtemp(join(tmpdir(), "agouti-laravel-"));
  await writeFile(join(dir, "artisan"), "#!/usr/bin/env php\n");
  await writeFile(join(dir, "composer.json"), JSON.stringify({ require: { "laravel/framework": "^11.0" } }));
  await writeFile(join(dir, "composer.lock"), JSON.stringify({ packages: [{ name: "laravel/framework", version: "v11.31.0" }] }));
  for (const d of ["storage/app/public/avatars", "storage/app/private/invoices", "storage/logs", "storage/framework/cache", "bootstrap/cache"]) {
    await mkdir(join(dir, d), { recursive: true });
  }
  await writeFile(join(dir, "storage/app/public/avatars/1.jpg"), Buffer.alloc(1500));
  await writeFile(join(dir, "storage/app/private/invoices/88.pdf"), Buffer.alloc(500));
  await writeFile(join(dir, "storage/logs/laravel.log"), "log");
  await writeFile(join(dir, ".env"), ENV);
  return dir;
}
