import { runBackup } from "../flows/backup.js";

export const usage = `Usage: agouti backup [<app>...]

Back up apps now: each one's database and files, as one restore point.
With no app names, backs up every app. Exits with status 1 if any app failed,
so it can be used before a risky deploy:

  sudo agouti backup shop && php artisan migrate`;

export const options = {};

export async function backup({ positionals }) {
  const results = await runBackup(positionals);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}
