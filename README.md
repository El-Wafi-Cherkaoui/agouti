<div align="center">

# Agouti

**Backups for the apps on your server: database and files, tested and restorable.**

Set it up in ten minutes. Forget about it. Trust it on the worst day.

> **Status:** in design. This README describes the intended v0.1 and is not published yet.

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

Runs on Linux servers. Needs access to `mysqldump`, either installed locally or inside your database's Docker container.

## Get started

### 1. Connect storage (once per server)

```sh
$ sudo agouti init

? Where should backups go?        Cloudflare R2
? Bucket endpoint                 https://<id>.r2.cloudflarestorage.com/backups
? Access key / secret             ********
? Enable append-only protection?  Yes (recommended)

✓ Repository created and encrypted
⚠ Your recovery key (store it OUTSIDE this server, e.g. a password manager):
  agouti-rk-7F3K-92QX-....
  Without it, backups cannot be restored if this server is lost.
```

### 2. Add each app

```sh
$ sudo agouti add /var/www/shop

Detected: Laravel 11
  Database   MySQL 8.0  shop_prod @ 127.0.0.1   (from .env)
  Files      [x] storage/app/public    2.1 GB  14,302 files
             [x] storage/app/private   640 MB   3,118 files
             [ ] storage/logs          (excluded: logs)
             [ ] storage/framework     (excluded: cache)

? Create a least-privilege MySQL backup user?  Yes
? Run a first backup now?                       Yes

Backing up shop ...
  database   48 MB → 9 MB compressed       ✓ 6s
  files      2.7 GB, 17,420 files           ✓ 11m 32s
✓ Restore point shop@2026-11-03T14:20  (verified: pending)
```

Repeat for every app on the server. They all share one repository and one schedule.

### 3. Turn on automatic backups

```sh
$ sudo agouti schedule --daily 03:00 --notify discord:https://...

✓ systemd timer installed: agouti-backup.timer
✓ Weekly restore test: Sundays 04:00
✓ Healthcheck ping configured. You'll be alerted if a backup is MISSED.
```

That's it. From now on, every night Agouti:

1. Dumps each database (without locking your tables).
2. Backs up only the files that changed since last time.
3. Tags both with one **restore point**, so the database and files always match.
4. Deletes restore points you no longer need.
5. Pings your healthcheck. If the ping doesn't arrive, you get an alert.

Every week it restores the latest backup into a throwaway database and checks it.

## See how things stand

```sh
$ agouti
```

```
 agouti · 3 projects · repo: R2 (append-only)                        ? help
 ─────────────────────────────────────────────────────────────────────────────
  PROJECT   LAST BACKUP      SIZE     POINTS   VERIFIED
 ▸ shop     ✓ 6h ago         2.8 GB   23       ✓ Sun 04:00
   blog     ✓ 6h ago         310 MB   23       ✓ Sun 04:00
   crm      ✕ failed 6h ago  1.1 GB   22       ⚠ 8 days ago
 ─────────────────────────────────────────────────────────────────────────────
  Enter details   b backup now   r restore   l logs   v verify now   q quit
```

When something fails, you also get a message:

> ✕ **shop** backup failed at 03:00: MySQL access denied for user 'agouti_backup'. Run `agouti doctor shop`.

## Restore

**One file**: a customer deleted their invoice.

```sh
$ agouti restore shop --file storage/app/private/invoices/88.pdf
? From which restore point?  2026-11-02 03:00 (yesterday)
✓ Restored 1 file (owner www-data, mode 0640)
```

**The database**: a migration went wrong.

```sh
$ agouti restore shop --db --at "2026-11-03 03:00"

This will replace database shop_prod:
  62 tables · 1,204,331 rows now → 1,198,870 rows in backup
  Current database will be kept as shop_prod_before_restore

Type "shop_prod" to confirm: shop_prod
✓ Restored in 41s
```

**Everything, on a new server**: the old one is gone.

```sh
$ npm install -g agouti
$ agouti connect r2:...backups --recovery-key agouti-rk-7F3K-...
$ agouti restore shop --all --to /var/www/shop
✓ Database + 17,420 files restored. Run your deploy, then point DNS here.
```

Before a risky deploy, make a restore point by hand:

```sh
agouti backup shop
```

## What it detects

| Framework | Backs up | Skips |
| --- | --- | --- |
| Laravel | `storage/app/public`, `storage/app/private` | `storage/framework`, `storage/logs`, `bootstrap/cache` |
| WordPress | `wp-content/uploads` | `wp-content/cache` |
| Django | `MEDIA_ROOT` | `STATIC_ROOT` |
| Rails | `storage/` (Active Storage) | `tmp/`, `log/` |
| Node.js | `uploads/` and similar | `node_modules` |
| Docker | named volumes used for uploads | |

Database connection details come from `.env`, `docker-compose.yml`, `schema.prisma`, `database.yml` or Django settings. You always confirm what was found, and you can change it.

## Configuration

`agouti add` writes this for you. You can also edit it directly at `/etc/agouti/agouti.yml`:

```yaml
projects:
  shop:
    path: /var/www/shop
    database: { from: .env }
    files:
      - storage/app/public
      - storage/app/private
    exclude: [storage/app/public/thumbs]
    verify:
      references: "SELECT path FROM media"   # check every referenced file is in the backup

schedule: daily 03:00
retention: { daily: 7, weekly: 4, monthly: 12 }
repository: s3:https://<id>.r2.cloudflarestorage.com/backups
notify:
  healthcheck: https://hc-ping.com/...
  discord: https://discord.com/api/webhooks/...
```

## Verified backups

A backup you have never restored is a guess. Agouti checks, on a schedule:

- **Database:** restores into a throwaway database and checks that tables and row counts look right. You can add your own checks.
- **Files:** downloads a sample of files and compares checksums.
- **References:** optionally, runs a query that lists the file paths your database points to, and confirms every one of them is in the same restore point.

Each restore point is marked `✓ verified`, `⚠ unverified` or `✕ failed`.

## Security

- Backups are **encrypted before they leave the server**.
- **Append-only storage** (Object Lock, or an append-only REST server) means an attacker on your server can add backups but not delete them.
- Database passwords go through a private option file, never the command line, where `ps` could show them.
- `agouti add` can create a MySQL user that can **only read** what a backup needs.
- Restores never overwrite without showing what changes and asking you to type the database name. The old database is kept until you remove it.

## Under the hood

Agouti handles detection, scheduling, dumps, verification, alerts and restores. Storage, encryption, deduplication and retention are done by [restic](https://restic.net), a proven backup engine. Agouti downloads a pinned, checksum-verified copy for you. Database dumps stream straight into restic, so they are never written to disk in plain text.

Storage: Amazon S3, Cloudflare R2, Backblaze B2, MinIO, any S3-compatible service, SFTP, or a local disk.

## What Agouti isn't

Agouti backs up **the apps running on your server**: their databases and their files. It is not a full-server or disk-image backup, a database replication tool, a monitoring system, or a dev-database snapshot tool. v0.1 supports MySQL and MariaDB; Postgres is planned.

## Roadmap

- **v0.1:** detect → back up (database + files) → schedule → retention → healthcheck → restore (full, database, files, single file)
- **v0.2:** restore verification, including the reference check · status TUI
- **Later:** point-in-time recovery from binlogs · `mydumper` for large databases · dumps from a replica · Postgres · backing up S3-hosted uploads · single binary and Docker image

## Related

By the author of [Sable](https://github.com/El-Wafi-Cherkaoui/Sable), the terminal workspace manager for your local stack.

## License

MIT
