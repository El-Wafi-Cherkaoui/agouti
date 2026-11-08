<div align="center">

# Agouti

**Backups for the apps on your server: database and files, tested and restorable.**

Set it up in ten minutes. Forget about it. Trust it on the worst day.

> **Status:** in development, and not published yet: `npm install -g agouti` only gets a placeholder for now. The commands below work from a checkout of this repository. Sections marked *planned* aren't built.

</div>

## Why

The agouti is a rodent that buries seeds in many places and comes back for them months later. Whole forests grow from the ones it saves.

Most small apps on a VPS are backed up by a cron script someone wrote years ago, or not at all. When that script breaks, nothing tells you. When you finally need a backup, you find out whether it works.

Agouti backs up each app's **MySQL/MariaDB database and its uploaded files** (public and private: images, documents, invoices) to storage outside the server. It encrypts everything, keeps the right number of copies, alerts you when a backup fails *or doesn't run*, and regularly **restores your backups to prove they work**.

## Install

```sh
npm install -g agouti
```

A single binary that doesn't need Node.js and a Docker image are planned too.

Runs on Linux servers. Needs `bzip2` (to unpack restic) and `mysqldump` or `mariadb-dump` on the server (`apt install bzip2 mysql-client`, or `mariadb-client`). A database inside a Docker container isn't supported directly yet: its port must be reachable from the server.

## Get started

```sh
sudo agouti
```

That's the only command you need to remember. On a new server it walks you through setup: storage, then your apps, then the schedule. After that it opens a home screen where every action (add an app, back up, restore, test a restore) is a keypress away.

Every action is also a plain command, for scripts, timers and quick use over SSH. The steps below show the commands; the interactive app asks the same questions.

### 1. Connect storage (once per server)

```sh
$ sudo agouti init

? Where should backups go?        Cloudflare R2
? Bucket endpoint                 https://<id>.r2.cloudflarestorage.com/backups
? Access key / secret             ********

✓ Repository created and encrypted
⚠ Your recovery key (store it OUTSIDE this server, e.g. a password manager):
  agouti-rk-7F3K-92QX-....
  Without it, backups cannot be restored if this server is lost.
```

### 2. Add each app

```sh
$ sudo agouti add /var/www/shop

Detected: Laravel 11

⚠ Agouti needs this app's database connection details.
  They're in /var/www/shop/.env, which usually also holds the app's most
  sensitive secrets (APP_KEY, mail and payment keys...).
  [what Agouti would read and keep, how serious it is, what we suggest]

? How should Agouti connect to the database?
❯ Create a read-only backup user (recommended)
  Read the details from .env
  Enter the details of an existing database user

✓ Connected: MySQL 8.0 · shop_prod · 62 tables · 48 MB

? Which folders hold uploaded files to back up?
❯◉ storage/app/private    640 MB · 3,118 files
 ◉ storage/app/public     2.1 GB · 14,302 files
 ◯ storage/logs           (logs)
 ◯ storage/framework      (cache)

✓ Added shop
```

Agouti never reads `.env` without asking. If you allow it, it keeps only the `DB_*` lines and discards the rest. Even then, we recommend the read-only backup user: Agouti gives you the SQL, and a leaked backup password can't change or delete your data.

Repeat for every app on the server. They all share one repository and one schedule.

### 3. Turn on automatic backups

The app offers this right after your first app ("Turn on daily automatic backups now?"). Or in one line:

```sh
$ sudo agouti schedule --daily 03:00 --healthcheck https://hc-ping.com/<uuid>

✓ Daily backups at 03:00 (Europe/Paris) · next: Wed 2026-11-04 03:00:00 CET
✓ Healthcheck: hc-ping.com/1f2e3d…. You'll be alerted if a backup fails or doesn't run.
Logs: journalctl -u agouti-backup
```

That's it. From now on, every night Agouti:

1. Dumps each database (without locking your tables).
2. Backs up only the files that changed since last time.
3. Tags both with one **restore point**, so the database and files always match.
4. Deletes restore points you no longer need (by default it keeps 7 daily, 4 weekly and 12 monthly). A restore point is kept or deleted as a whole, never half of it.
5. Pings your healthcheck. If a backup fails, or the ping never arrives (server off, timer broken), you get an alert.

A timer can't tell you that it stopped running, so the healthcheck matters. [healthchecks.io](https://healthchecks.io) is free, or self-host it: create a check with period 1 day and grace 1 hour. The ping URL is kept in the root-only `credentials.env`, because anyone holding it could send fake "all good" pings.

Every week it also restores the latest backup for real and checks it (see [Verified backups](#verified-backups)).

## See how things stand

```sh
$ agouti
```

```
agouti · 3 apps · repo: R2 · append-only (R2 locks)
  APP           LAST BACKUP                   RESTORE TEST
  shop          ✓ 6h ago                      ✓ 2 days ago
  blog          ✓ 6h ago                      ✓ 2 days ago
  crm           ✕ failed 6h ago (last good: yesterday)  ⚠ 2 days ago

✓ Daily backups at 03:00 (Europe/Paris)
  next: Wed 2026-11-04 03:00:00 CET
  keeps 7 daily, 4 weekly, 12 monthly restore points
  healthcheck: hc-ping.com/1f2e3d…
  restore test: weekly

? What do you want to do?
❯ Back up now
  Add an app
  Automatic backups
  Restore
  Test a restore
  Alerts
  ...
```

### Alerts

When a scheduled backup has a problem, you get a message saying what went wrong and what to do, on **Discord, Slack, Telegram, ntfy** (push to your phone) or any **webhook**:

> ✕ Agouti on vps-1: a problem with tonight's backup
> • crm: the database wasn't backed up: Access denied for user 'agouti_crm'@'localhost'
> &nbsp;&nbsp;Has the password of agouti_crm changed? Credentials are in /etc/agouti/projects/crm.cnf.

You get one more message when things work again. Nothing is sent while everything works.

```sh
sudo agouti alerts                                   # set up (sends a test)
sudo agouti alerts --add discord --to https://discord.com/api/webhooks/...
sudo agouti alerts --add telegram --to <bot token>   # after sending the bot a message
```

Alerts cover what a run reports: failed backups, files that couldn't be read, a restore test that failed or looks wrong, storage that's no longer append-only, and cleanup errors. A server that's off can't send anything, which is what the healthcheck is for: it alerts you when a run *doesn't happen*. For email, use your healthcheck's email notifications, which include Agouti's report. Webhook URLs and bot tokens are kept in the root-only `credentials.env`.

## Restore

`sudo agouti` → **Restore** walks you through it: pick the app, the restore point, what to restore (everything, the database, the files, or one file), and how.

By default a restore is a **copy**, next to the live data, so it's always safe to try: the database goes into a new database, the files into `/var/lib/agouti/restores`. Nothing live is touched. **Replace** overwrites the live data, but only after you type the app's name, and only after Agouti saves the current state as a restore point, so you can undo it.

**One file**: a customer deleted their invoice.

```sh
$ sudo agouti restore shop --file storage/app/private/invoices/88.pdf
✓ Restored to /var/lib/agouti/restores/shop-20261103T030000Z/storage/app/private/invoices/88.pdf
```

In the app, you can search by name instead of typing the path.

**The database, to look at it**: what did that table look like yesterday?

```sh
$ sudo agouti restore shop --only database --point 20261102T030000Z
  ✓ database  restored into shop_prod_restored_20261102_0300 · 62 of 62 tables · 41s

Look at the database: mysql shop_prod_restored_20261102_0300
Drop it when you're done: DROP DATABASE `shop_prod_restored_20261102_0300`;
```

**Everything, in place**: a migration went wrong.

```sh
$ sudo agouti restore shop --replace
This replaces the live database and files of shop. Type shop to confirm: shop
✓ Current state saved: restore point 20261103T142542Z
  ✓ database  shop_prod replaced · 62 of 62 tables · 44s
  ✓ files     2 folders replaced · 17,420 files · 3.1 GB · 2m10s
✓ Restored shop @ 2026-11-03 03:00 (UTC)

To undo: sudo agouti restore shop --point 20261103T142542Z --replace
```

Only the folders you back up are replaced. Your app's code and other folders are never touched. Pressing Ctrl-C or losing the SSH connection mid-replace doesn't stop it halfway. Pressing Ctrl-C twice does, and Agouti tells you how to undo.

Restoring a database needs a MySQL user that can create databases (the backup user can only read). Agouti uses root through the local socket, which is the default on Debian and Ubuntu, or asks for one (`--db-admin-user`, password in `AGOUTI_DB_ADMIN_PASSWORD`).

See all restore points with `sudo agouti restore shop --list`.

**Everything, on a new server**: the old one is gone.

Every backup also stores a short description of each app (its folder, database and backed-up folders, never passwords), so a new server can find your apps with just the recovery key:

```sh
$ npm install -g agouti
$ sudo agouti
? Is this a new setup? No, connect to an existing repository
...
✓ Connected to Cloudflare R2 (backups)

Found 1 app in the backups:
  shop    /var/www/shop · database shop_prod · last backup yesterday 03:00 on old-vps

? Restore it on this server now? Yes
? Where should shop go on this server? /var/www/shop
? Database name on this server shop_prod
  ✓ database  restored into shop_prod · 62 of 62 tables · 41s
  ✓ files     17,420 files · 3.1 GB → /var/www/shop/storage/app/public, /var/www/shop/storage/app/private
? Keep backing up shop on this server? Yes
✓ shop is set up on this server (backup user agouti_shop, read-only).
? Turn on daily automatic backups? Yes
```

Deploy the code first if you can (`git clone` refuses a folder that isn't empty). Agouti only restores into an empty database and empty folders, so nothing on the new server is overwritten. It creates a read-only MySQL user for the app, so backups go on as before.

Before a risky deploy, make a restore point by hand:

```sh
agouti backup shop
```

## What it detects

Today Agouti detects **Laravel**: it backs up `storage/app/public` and `storage/app/private`, skips `storage/framework`, `storage/logs` and `bootstrap/cache`, and can read the database details from `.env`, but only after you allow it.

Any other app works too if you enter its database details and folders yourself.

*Planned:* detection for WordPress, Django, Rails, Node.js and Docker volumes.

## Configuration

`agouti add` writes this for you. You can also edit it directly at `/etc/agouti/agouti.yml`:

```yaml
projects:
  shop:
    path: /var/www/shop
    database:
      engine: mysql
      name: shop_prod
      host: 127.0.0.1
      port: 3306
      user: agouti_backup
      credentials: /etc/agouti/projects/shop.cnf   # password lives here, root-only
    files:
      - storage/app/public
      - storage/app/private
    exclude:                                   # left out of the backups
      - storage/app/public/thumbs              # a path inside one of the folders above
      - "*.tmp"                                # or a name, anywhere inside them

schedule: daily 03:00                          # written by `agouti schedule`
retention: { daily: 7, weekly: 4, monthly: 12 }
repository: s3:https://<id>.r2.cloudflarestorage.com/backups
# The healthcheck URL and storage keys live in credentials.env (root-only).
```

**Excluding files.** A rule with a `/` is a path from the app's folder and can use `*` and `?`. A rule without one is a name that matches anywhere in the backed-up folders. Set rules here, or with `agouti add --exclude thumbs,storage/app/public/tmp`.

A rule that can't be applied (a path outside the backed-up folders, or one that would leave out a whole folder) is ignored with a warning, so a typo can't shrink your backup. If the rules leave out every file, the backup counts as failed and you get an alert.

Excluded files can't be restored, but they're also safe from a restore: **Replace** leaves the files a restore point excluded exactly as they are.

## Protect backups from attackers

Backups are only as safe as the storage keys on your server. Someone who takes over the server (a hacked app, a stolen SSH key, ransomware) can use those keys to delete every backup, and often does before asking for money. `sudo agouti protect` makes the storage **append-only**: the server can add backups, but not delete or overwrite them.

- **Cloudflare R2:** bucket lock rules on the folders restic keeps (`config`, `keys/`, `snapshots/`, `data/`). Agouti adds them with a Cloudflare API token you give once (it isn't stored), or you add them in the dashboard. Nothing in those folders can be deleted by anyone until you remove the rules. That includes Agouti's own cleanup: retention pauses and storage only grows. restic's `locks/` and `index/` stay open, because restic needs them and the index can be rebuilt from the data.
- **AWS S3, Backblaze B2, other S3-compatible storage:** versioning, plus a key on the server that can't delete versions. Deleting or overwriting a file only hides it, and the previous version is kept for as long as your lifecycle rule says (30 days suggested). Agouti generates the exact IAM policy (AWS) or key command (B2). Retention keeps working as usual.
- **SFTP and local folders** can't refuse deletes, so they can't be protected.

```sh
$ sudo agouti protect --check
  ✓ versioning  on: deleted or overwritten files keep their previous version
  ✓ key         can't delete old versions
✓ Append-only storage is in place.
```

Agouti checks with the server's own key and never risks real data. On R2 it uses a write that can't succeed either way (Cloudflare checks the lock first). On versioned storage it uses a probe file of its own. Every scheduled backup checks again, so if someone removes the protection, your healthcheck tells you.

**After an attack** on versioned storage, put everything back as it was a moment before, with the server's own key (even on a rebuilt server):

```sh
$ sudo agouti rollback --to "2026-11-03 02:00"
Back to 2026-11-03 02:00:00 UTC: 21 files get their old version back, 3 files written since are hidden, 46 unchanged.
? Roll back? Yes
✓ Rolled back: 21 restored, 3 hidden. Nothing was deleted: it can be undone the same way.
```

Everything after that time is undone, including any genuine backups, so choose a time just before the attack. On R2, `agouti rollback` rebuilds the index, the only part an attacker could have touched. Then run `sudo agouti verify`.

## Verified backups

A backup you have never restored is a guess. Once a week (with the scheduled backup), or whenever you run `sudo agouti verify`, Agouti restores the latest restore point of each app for real:

- **Database:** loaded into a throwaway database (`agouti_verify_shop`), then every table's rows are counted, and the database is dropped.
- **Files:** a random sample is restored. Each file is checked for size, and compared byte for byte with the live file when that file hasn't changed since the backup.
- **Repository:** `restic check` confirms its structure is intact, and reads back one quarter of all the backup data, a different quarter each time. So every byte is read and checked once every 4 tests, about monthly, and each test downloads a quarter of the repository's size (free on a local disk and on R2, billed on S3 and B2). If the check can't run, the test isn't marked verified.
- **Compared with the last good test:** a backup can restore perfectly and still hold the wrong thing. If a table lost most of its rows, a table disappeared, or most files are gone, you get a warning, and the healthcheck reports a failure. The warning stays (later tests are compared with the last good one, not the previous one) until the data is back or you accept the change in the menu.

Backups watch for the same thing: when the database dump drops below half its usual size, or the files below half their usual count, the backup is saved but flagged, an alert goes out on scheduled runs, and older restore points aren't deleted for that app until the data is back or you choose **Accept a change in the data**. A wiped database, a mistaken `DROP` or an attack then can't push your healthy restore points out.

```sh
$ sudo agouti verify
✓ Repository: no errors · read part 2 of 4 of the backup data (all of it every 4 tests)

Testing shop: restore point 2026-11-03 03:00 (UTC) ...
  ✓ database  62 tables · 1,198,870 rows · 2 views · 1 procedure restored · 41s
  ✓ files     20 of 17,420 files restored · 18 identical to the live copy · 3s
✓ shop: backup verified
```

The throwaway database is created by a MySQL user Agouti sets up once, `agouti_verify`. It can **only create and drop databases named `agouti_verify_*`**, so it can't read or change your real databases. Agouti creates it with root through the local socket, or with an admin you give once and that isn't saved.

With binary logging on (the MySQL 8 default), MySQL only lets SUPER users create triggers and stored functions, so those are checked in the dump instead of loaded. Everything else is loaded. The home screen shows each app's last result: `✓ verified`, `⚠ looks wrong` or `✕ failed`.

## Security

- Backups are **encrypted before they leave the server**.
- **Append-only storage** (`sudo agouti protect`) means an attacker on your server can add backups but not delete or overwrite them. See [Protect backups from attackers](#protect-backups-from-attackers).
- Database passwords go through a private option file, never the command line, where `ps` could show them.
- `agouti add` asks before reading your app's `.env`, keeps only the database settings from it, and recommends a MySQL user that can **only read** what a backup needs (it gives you the SQL).
- Restores are copies unless you choose to replace, and replacing needs the app's name typed. The state before a replace is saved as a restore point first, so it can be undone.

## Under the hood

Agouti handles detection, scheduling, dumps, verification, alerts and restores. Storage, encryption, deduplication and retention are done by [restic](https://restic.net), a proven backup engine. Agouti downloads a pinned, checksum-verified copy for you. Database dumps stream straight into restic, so they are never written to disk in plain text.

Storage: Amazon S3, Cloudflare R2, Backblaze B2, MinIO, any S3-compatible service, SFTP, or a local disk.

The database dump is consistent: one transaction, so it's a single moment even while the app writes. Uploaded files are read one by one, without a disk snapshot, so a file still being written when it's read (an upload arriving) is saved as it was at that moment. Agouti names such files in the backup's result, and the next backup saves them whole.

## What Agouti isn't

Agouti backs up **the apps running on your server**: their databases and their files. It is not a full-server or disk-image backup, a database replication tool, a monitoring system, or a dev-database snapshot tool. v0.1 supports MySQL and MariaDB; Postgres is planned.

## Roadmap

- **v0.1:** detect (Laravel) → back up (database + files) → schedule → retention → healthcheck → restore (full, database, files, single file) → restore on a new server → weekly restore tests
- **v0.2:** the reference check (files your database points to) · status TUI
- **Later:** point-in-time recovery from binlogs · `mydumper` for large databases · dumps from a replica · Postgres · backing up S3-hosted uploads · single binary and Docker image

## Related

By the author of [Sable](https://github.com/El-Wafi-Cherkaoui/Sable), the terminal workspace manager for your local stack.

## License

MIT
