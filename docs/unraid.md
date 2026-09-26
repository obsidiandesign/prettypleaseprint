# Running it on Unraid

[← back to the README](../README.md)

This is the Unraid version of [Deployment](deployment.md): the same stack, laid
out for the **Compose Manager** plugin, behind **SWAG**, with the images built
by this fork's GitHub Actions. Everything it needs is in
[`deploy/unraid/`](../deploy/unraid/):

| File | Goes |
| --- | --- |
| [`docker-compose.yml`](../deploy/unraid/docker-compose.yml) | the stack's compose file in Compose Manager |
| [`env.example`](../deploy/unraid/env.example) | the stack's ENV file, filled in |
| [`pretty-please-print.subdomain.conf`](../deploy/unraid/pretty-please-print.subdomain.conf) | SWAG's `nginx/proxy-confs/` |
| [`sync.sh`](../deploy/unraid/sync.sh) | a User Scripts entry, every five minutes |

You need, before starting: Unraid with the **Compose Manager** and **User
Scripts** plugins (both from Community Applications), **SWAG** already serving
HTTPS for your domain, and **Bambuddy** reachable from the server (see
[Bambuddy and the sync](deployment.md#bambuddy-and-the-sync) for its side).

## 1. Get the images published (once, on GitHub)

The server pulls images; it never builds. They come from this fork's
**Release images** workflow, which publishes `ghcr.io/obsidiandesign/ppp-app`
and `ppp-migrate` on every push to `main`.

1. **Turn Actions on for the fork.** GitHub keeps a fork's workflows switched
   off until someone confirms them, and that can only be done in the browser:
   open the repository's **Actions** tab and click **I understand my
   workflows, go ahead and enable them**.
2. **Publish the first images** without waiting for a push: on the Actions tab,
   **Release images → Run workflow** on `main`. Or from a terminal:

   ```bash
   gh workflow run release-images.yml -R obsidiandesign/prettypleaseprint --ref main
   ```

3. **Let Unraid pull them.** A new package on ghcr.io may start out private.
   Either make both packages public (your GitHub profile → **Packages** →
   each package → **Package settings** → **Change visibility**), or log the
   server in, in the Unraid terminal, with a *classic* token that has only
   `read:packages`:

   ```bash
   docker login ghcr.io -u <your-github-username>
   ```

Each image is tagged with the 7-character commit SHA and `latest`. The
**Traffic** workflow also becomes active on the fork; it only records the
repository's traffic numbers, and you can disable it on the Actions tab if you
don't want the daily commit.

## 2. SWAG

The app joins SWAG's Docker network and publishes no port of its own, so SWAG
is the only way in. The files assume that network is called `proxynet`; if
yours is something else, set `PPP_PROXY_NETWORK` in the ENV file.

1. Copy `pretty-please-print.subdomain.conf` to
   `/mnt/user/appdata/swag/nginx/proxy-confs/`, and change `server_name
   print.*` to your subdomain.
2. Make sure SWAG's certificate covers that subdomain: add it to SWAG's
   `SUBDOMAINS` variable, unless you use a wildcard certificate.
3. Point the subdomain's DNS at your server as you have for your other SWAG
   sites, and restart SWAG.

Until the stack is up, SWAG answers that hostname with a `502`. That is
expected.

## 3. The stack in Compose Manager

1. **Docker tab → Add New Stack**, named e.g. `pretty-please-print`.
2. **Edit Stack → Compose File**: paste in `deploy/unraid/docker-compose.yml`.
3. **Edit Stack → ENV File**: paste in `deploy/unraid/env.example` and fill it
   out. At minimum:
   - the three secrets (`openssl rand -base64 32` for `BETTER_AUTH_SECRET` and
     `CRON_SECRET`, `openssl rand -hex 24` for `DB_PASSWORD`)
   - `APP_URL` (the `https://` address) and `PASSKEY_RP_ID` (the same hostname
     with no scheme). **Choose the hostname carefully**: passkeys are bound to
     it for good.
   - `DATA_ROOT`, on a pool rather than the `/mnt/user` FUSE layer
   - `ADMIN_EMAIL`, `ADMIN_NAME`
   - `BAMBUDDY_API_KEY` and `BAMBUDDY_PIPELINE_ID`
4. **Compose Up.**

The first start creates the database, applies migrations and creates the
admin. Then read the migrator's log for the admin's one-use setup link:

```bash
docker logs ppp-migrate
```

Open it within thirty minutes to choose a username and a password. Missed it?
**Compose Up** again; the migrator prints a fresh link until a password is
set.

Then sign in at your `APP_URL` and invite people from `/admin/invites`.

## 4. The sync

Ticket status moves by polling Bambuddy, and nothing inside the stack does the
polling. In **Settings → User Scripts**:

1. **Add New Script**, named e.g. `pretty-please-print-sync`, and paste in
   `deploy/unraid/sync.sh`.
2. Set its schedule to **Custom** and `*/5 * * * *`.
3. **Run Script** once to check: it should print `200 {"processed":0}`.

The script runs the call from inside the app container, so `CRON_SECRET`
never leaves the ENV file and the sync route can stay blocked at SWAG.

## Updating and rolling back

Every push to `main` publishes new images. To move to one:

1. Set `PPP_TAG` in the ENV file to its 7-character SHA (the **Release
   images** run lists it, and so does `git log --oneline`).
2. **Update Stack**, which pulls the images and recreates the containers. The
   migrator applies any new migrations before the app starts.

Rolling back is the same with the previous SHA. A rollback across a migration
is not automatic; restore the database from before the update (below) if one
was applied. Staying on `latest` works too, but then whatever was last pushed
is what an update gives you.

## Backups

Two things matter: `DATA_ROOT` (the database) and the ENV file (the secrets,
including the database password it was created with). Compose Manager keeps
the ENV file on the flash drive, under
`/boot/config/plugins/compose.manager/projects/<stack>/`, so it is in Unraid's
flash backup. Copy it somewhere else too.

For the database, a logical dump is the safe copy, and it can run while the
stack is up. As a nightly User Scripts entry:

```bash
#!/bin/bash
mkdir -p /mnt/user/backups/pretty-please-print
docker exec ppp-db pg_dump -U ppp -Fc ppp \
  > /mnt/user/backups/pretty-please-print/ppp-$(date +%F).dump
```

If you back up appdata with a plugin that copies files, make sure it stops
`ppp-db` first: a copy of a running Postgres directory isn't a reliable
backup. The README's [Backup and restore](../README.md#backup-and-restore)
covers restoring either kind.

## When something's wrong

**`502` from SWAG.** Check the app is on SWAG's network, and that the name
resolves from SWAG:

```bash
docker network inspect proxynet --format '{{range .Containers}}{{.Name}} {{end}}'
docker exec swag curl -sS -m 5 http://ppp-app:3000/api/health
```

**The app won't start, and has no logs.** Look at the migrator, which is the
container that's meant to exit: `docker logs ppp-migrate`. A wrong
`DB_PASSWORD` shows up there as `P1000: Authentication failed`.

**`unauthorized` when pulling.** The packages are private and the server
isn't logged in. See step 1.3.

**Postgres won't start after a permissions tool ran.** Unraid's *Docker Safe
New Permissions* (and similar) resets `appdata` to `nobody:users`, and
Postgres refuses to run on a data directory it doesn't own. Exclude
`DATA_ROOT` from those tools. To repair it, stop the stack and restore
ownership to the container's `postgres` user (uid 70):

```bash
chown -R 70:70 /mnt/cache/appdata/pretty-please-print/db
```

**Tickets stay `Requested`, or stop moving.** Run the sync script by hand and
read what it prints. `401` means `CRON_SECRET` is unset in the ENV file. For
Bambuddy-side problems (Bambu Cloud sign-in, the pipeline), the ticket itself
carries the reason, and the admin is notified.

**Audit rows have no IP address.** That's `TRUST_PROXY_HEADERS=false`, which
is correct behind SWAG; see the comment in the ENV file.
