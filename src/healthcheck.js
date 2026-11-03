// Healthcheck pings (healthchecks.io, or any compatible service such as a
// self-hosted Healthchecks). A timer can't report that it stopped running; a
// healthcheck can: it alerts when a "fail" ping arrives, and when no ping arrives
// at all (server off, timer broken, disk full...).
//
// The ping URL is stored in credentials.env (root-only), not in agouti.yml: anyone
// holding it could send fake "success" pings and hide real failures.
import { loadCredentials, saveCredentials } from "./config.js";
import { paths } from "./paths.js";
import { UserError } from "./ui.js";

const KEY = "AGOUTI_HEALTHCHECK_URL";

export async function loadHealthcheck(p = paths()) {
  return (await loadCredentials(p))[KEY] || null;
}

export async function saveHealthcheck(url, p = paths()) {
  const creds = await loadCredentials(p);
  if (url) creds[KEY] = validateHealthcheckUrl(url);
  else delete creds[KEY];
  await saveCredentials(creds, p);
}

export function validateHealthcheckUrl(url) {
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    throw new UserError(`Not a URL: ${url}`, "Paste the check's ping URL, e.g. https://hc-ping.com/1f2e3d4c-...");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new UserError(`The ping URL must start with https://`);
  return u.toString().replace(/\/+$/, "");
}

// kind: "start" | "success" | "fail". Never throws: a monitoring hiccup must not
// fail a backup. Returns { ok, error }.
export async function ping(url, kind = "success", body = "", { timeoutMs = 10000, tries = 3 } = {}) {
  const target = kind === "success" ? url : `${url}/${kind}`;
  let error;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(target, {
        method: body ? "POST" : "GET",
        body: body ? body.slice(-90000) : undefined, // healthchecks.io keeps up to 100 KB
        headers: { "user-agent": "agouti" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return { ok: true };
      error = `HTTP ${res.status}`;
      if (res.status < 500) break; // wrong URL: retrying won't help
    } catch (err) {
      error = err.cause?.code ?? err.cause?.message ?? err.message;
    }
    if (attempt < tries) await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  return { ok: false, error };
}
