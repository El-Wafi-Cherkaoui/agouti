import { join } from "node:path";

// Where Agouti keeps things on the server. Both can be overridden with
// environment variables, which is how tests run without root.
export function paths(env = process.env) {
  const configDir = env.AGOUTI_CONFIG_DIR || "/etc/agouti";
  const dataDir = env.AGOUTI_DATA_DIR || "/var/lib/agouti";
  return {
    configDir,
    dataDir,
    config: join(configDir, "agouti.yml"),
    // Secrets live outside agouti.yml so the config can be read and shared freely.
    credentials: join(configDir, "credentials.env"),
    recoveryKey: join(configDir, "recovery-key"),
    // One MySQL option file per app with its database credentials (root-only).
    projectsDir: join(configDir, "projects"),
    binDir: join(dataDir, "bin"),
    cacheDir: join(dataDir, "cache"),
  };
}
