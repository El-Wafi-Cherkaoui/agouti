import { join } from "node:path";
import { isWindows } from "./platform.js";

// Where Agouti keeps things on the server. Both can be overridden with
// environment variables, which is how tests run without root.
// Linux: /etc/agouti and /var/lib/agouti. Windows: C:\ProgramData\Agouti\config and
// ...\data (made readable by Administrators and SYSTEM only, see makePrivate).
export function defaultDirs(env = process.env, platform = process.platform) {
  if (!isWindows(platform)) return { configDir: "/etc/agouti", dataDir: "/var/lib/agouti" };
  const base = join(env.ProgramData || env.PROGRAMDATA || "C:\\ProgramData", "Agouti");
  return { configDir: join(base, "config"), dataDir: join(base, "data") };
}

export function paths(env = process.env) {
  const defaults = defaultDirs(env);
  const configDir = env.AGOUTI_CONFIG_DIR || defaults.configDir;
  const dataDir = env.AGOUTI_DATA_DIR || defaults.dataDir;
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
