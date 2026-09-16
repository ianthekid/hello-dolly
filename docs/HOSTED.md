# HOSTED — run the clone tool permanently on the droplet

Ops runbook. **You apply this by hand, as root, on the droplet.** No agent executes it, and
nothing in it is checked into the repo (nginx config, the unit file and `.env.hosted` all
live on the box).

Assumes SETUP.md's droplet: Ubuntu 24.04, node from nodesource (`/usr/bin/npm`), user
`build`, checkout at `/home/build/website-clone`. Phase 4.1 (`HOSTED=1` support) must be
committed and pulled first.

Result: `https://<your-domain>/` is the clone UI, `https://<your-domain>/preview/<domain>/`
is any finished clone. Both behind basic-auth. Nothing else is reachable.

---

## 1. Secrets — `/home/build/website-clone/.env.hosted`

```bash
sudo -u build tee /home/build/website-clone/.env.hosted >/dev/null <<'EOF'
HOSTED=1
PORT=3999
FIRECRAWL_API_KEY=fc-...
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat...
EOF
chmod 600 /home/build/website-clone/.env.hosted
chown build:build /home/build/website-clone/.env.hosted
```

- `.env.*` is gitignored — this file never reaches the repo. Keep it out of backups you share.
- systemd's `EnvironmentFile` is **not** a shell: no `export`, no quotes, no `$VAR`
  expansion, no inline comments after a value.
- `pipeline.ts` also does `process.loadEnvFile('.env')` and that call **overwrites** what
  systemd passed in. So: do not keep a `.env` on the droplet. If one exists with a stale
  key, delete it — `.env.hosted` is the only source of truth here.

## 2. systemd unit — `/etc/systemd/system/website-clone.service`

```ini
[Unit]
Description=website-clone UI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=build
Group=build
WorkingDirectory=/home/build/website-clone
EnvironmentFile=/home/build/website-clone/.env.hosted
Environment=PATH=/home/build/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/npm run ui
Restart=always
RestartSec=5
StandardOutput=append:/home/build/website-clone/logs/ui.log
StandardError=append:/home/build/website-clone/logs/ui.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo -u build mkdir -p /home/build/website-clone/logs
systemctl daemon-reload
systemctl enable --now website-clone
systemctl status website-clone --no-pager
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3999/   # expect 200
```

- `which npm` first. If node came from nvm rather than nodesource, fix `ExecStart` and the
  `PATH=` line to the real paths — systemd has no login shell and no `~/.bashrc`.
- `PATH` must include wherever `claude` lives (`/home/build/.npm-global/bin` per SETUP.md)
  or the Agent SDK cannot launch the rebuild.
- Logs: `journalctl -u website-clone -f` or `tail -f logs/ui.log`.
- After a `git pull`: `systemctl restart website-clone`.

## 3. nginx

```bash
apt-get install -y nginx apache2-utils
htpasswd -c /etc/nginx/.htpasswd ian     # prompts for a password
chmod 640 /etc/nginx/.htpasswd && chown root:www-data /etc/nginx/.htpasswd
```

nginx (`www-data`) must be able to traverse to the exports:

```bash
chmod o+x /home/build /home/build/website-clone /home/build/website-clone/sites
```

`/etc/nginx/sites-available/website-clone`:

```nginx
server {
    listen 80;
    server_name clones.example.com;          # or the droplet IP — see TLS note below

    client_max_body_size 2m;

    auth_basic "website-clone";
    auth_basic_user_file /etc/nginx/.htpasswd;

    # --- SSE: no buffering, no timeout. Regex wins over the "/" prefix location. ---
    location ~ ^/api/clone/[^/]+/events$ {
        auth_basic "website-clone";
        auth_basic_user_file /etc/nginx/.htpasswd;

        proxy_pass http://127.0.0.1:3999;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        gzip off;
        proxy_read_timeout 24h;
        proxy_send_timeout 24h;
    }

    # --- finished clones, served straight off disk. Zero-touch for new domains. ---
    location ~ ^/preview/(?<dom>[^/]+)$ {
        return 301 /preview/$dom/;
    }

    location ~ ^/preview/(?<dom>[^/]+)(?<rest>/.*)$ {
        auth_basic "website-clone";
        auth_basic_user_file /etc/nginx/.htpasswd;

        root /home/build/website-clone/sites/$dom/app/out;
        rewrite ^/preview/[^/]+(/.*)$ $1 break;
        try_files $uri $uri.html $uri/index.html =404;
    }

    # --- the UI ---
    location / {
        proxy_pass http://127.0.0.1:3999;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

```bash
ln -sf /etc/nginx/sites-available/website-clone /etc/nginx/sites-enabled/website-clone
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

Notes:

- `$dom` is a **named** capture on purpose: the `rewrite` below it overwrites `$1`, so a
  numbered capture in `root` would silently point at the wrong directory.
- A clone directory that does not exist gives a 404 from `try_files`, which is correct — a
  `/preview/<anything>/` probe leaks nothing but a 404, and basic-auth is in front of it.
- Nothing here needs editing when a new clone is built. The regex covers `sites/*`.

### TLS

With a real domain (A record → droplet IP):

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d clones.example.com --redirect -m ian@ianray.com --agree-tos
```

**Without a domain, there is no certificate** — basic-auth over plain HTTP sends the
password in clear text on every request. Either point a hostname at the droplet, or skip
nginx for the UI entirely and reach it over an SSH tunnel:
`ssh -N -L 3999:127.0.0.1:3999 build@<ip>`.

## 4. ufw

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 'Nginx Full'          # 80 + 443
ufw deny 3999                   # explicit: the UI is proxy-only
ufw deny 4321:4521/tcp          # legacy npx-serve preview range, never public
ufw --force enable
ufw status verbose
```

`default deny incoming` already closes 3999 and the preview range; the explicit rules are
there so the intent survives the next person who adds an `allow`. Phase 4.1 also binds the
UI to `127.0.0.1` when `HOSTED=1`, so this is the second lock, not the only one.

## 5. Existing clones built before Phase 4.1

Anything already in `sites/` was exported without a `basePath`, so it will render unstyled
and imageless under `/preview/`. Per domain, either re-run the clone from the UI (cleanest),
or rebuild the export in place:

```bash
sudo -u build -i
cd /home/build/website-clone/sites/<domain>/app
# add basePath to next.config.ts:
#   export default { output: 'export', images: { unoptimized: true }, basePath: '/preview/<domain>' }
npx next build
```

Root-absolute `/logo.png`-style references written by the page-builders still need the
rebase pass; re-running the clone from the UI applies it automatically, a manual
`next build` does not.

## 6. Smoke checklist

```bash
H=clones.example.com; U=ian:<password>; D=<a-built-domain>

# UI answers through nginx, and only through nginx
curl -sS -o /dev/null -w '%{http_code}\n' -u "$U" https://$H/                 # 200
curl -sS -o /dev/null -w '%{http_code}\n'          https://$H/                # 401
curl -sS -m 5 -o /dev/null -w '%{http_code}\n' http://<droplet-ip>:3999/      # fails/timeout

# unknown API route still 404s (not 502)
curl -sS -o /dev/null -w '%{http_code}\n' -u "$U" https://$H/api/clone/nope/events   # 404

# SSE is not buffered: headers come back immediately, no Content-Length, no gzip
curl -sS -N -D- -o /dev/null -m 3 -u "$U" https://$H/api/clone/nope/events

# preview serves, and its assets are prefixed
curl -sS -o /dev/null -w '%{http_code}\n' -u "$U" https://$H/preview/$D/            # 200
curl -sS -u "$U" https://$H/preview/$D/ | grep -o '/[a-z_/.-]*_next[^"]*' | head -3
#   -> every hit must start with /preview/$D/_next/ . If they start with /_next/ ,
#      add  assetPrefix: '/preview/<domain>'  next to basePath and rebuild.
curl -sS -u "$U" https://$H/preview/$D/ | grep -o 'src="[^"]*"' | head -5
#   -> local images must start with /preview/$D/ ; a bare /foo.png means the rebase pass
#      did not run (check run.log for "rebased N file(s)").

# an asset actually resolves
curl -sS -o /dev/null -w '%{http_code}\n' -u "$U" "https://$H/preview/$D/_next/static/..."  # 200

# survives a reboot
reboot   # then: systemctl is-active website-clone nginx   -> active / active
```

Then, in a browser: load `https://$H/`, start a clone, confirm the step list ticks live
(that is the SSE path — if steps only appear at the end, `proxy_buffering off` is not taking
effect), approve the review gate, and click the `/preview/<domain>/` link in the final log
line.
