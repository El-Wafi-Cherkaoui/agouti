import { runBackup, scheduledBackup } from "../flows/backup.js";

export const usage = `Usage: agouti backup [<app>...]

Back up apps now: each one's database and files, as one restore point.
With no app names, backs up every app. Exits with status 1 if any app failed,
so it can be used before a risky deploy:

  sudo agouti backup shop && php artisan migrate

Options:
  --scheduled   What the daily timer runs: back up every app, delete restore
                points no longer needed, then ping the healthcheck.`;

export const options = { scheduled: { type: "boolean" } };

export async function backup({ positionals, values }) {
  const ok = values.scheduled ? await scheduledBackup(positionals) : (await runBackup(positionals)).every((r) => r.ok);
  if (!ok) process.exitCode = 1;
}
