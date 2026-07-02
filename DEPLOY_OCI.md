# Deploying the SalePilot backend on Oracle Cloud (Always Free)

Production runs on a single **Ampere A1** VM (Always Free): three containers via
`docker-compose.prod.yml` — Postgres (internal only), the Node backend, and
Caddy (automatic HTTPS on `API_DOMAIN`).

Current deployment: VM `92.4.133.193`, app dir `/home/ubuntu/salepilot/s-back`,
domain `api.salepilot.space`.

## One-time VM setup (already done)
1. Ubuntu ARM instance (VM.Standard.A1.Flex), reserved public IP.
2. OCI Security List ingress: TCP 22, 80, 443 from 0.0.0.0/0.
3. OS firewall (Oracle images block by default):
   ```bash
   sudo iptables -I INPUT 5 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 5 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo apt-get install -y iptables-persistent && sudo netfilter-persistent save
   ```
4. Docker via `curl -fsSL https://get.docker.com | sudo sh`, `usermod -aG docker ubuntu`.

## Deploy / redeploy (git-based — primary)
The VM's `~/salepilot/s-back` is a git clone of `main`. Every deploy:
```powershell
# on the dev machine: commit + push
git add -A ; git commit -m "..." ; git push
```
```bash
# on the VM (or via ssh one-liner)
~/salepilot/s-back/deploy/pull-and-rebuild.sh
```
Prints `DEPLOY_OK — running commit: <sha>` on success. Production always
corresponds to a pushed commit on main.

Alternative (deploys the working tree as-is, no commit needed):
`.\deploy\deploy.ps1` from the dev machine (tar → scp → build).

The server's `.env` lives at `~/salepilot/s-back/.env` (chmod 600, untracked)
and is never touched by pulls or the tarball flow. Template:
`.env.production.example`. Critical values: `POSTGRES_PASSWORD`, `JWT_SECRET`,
`API_DOMAIN`, `FRONTEND_URL`, `NODE_ENV=production`.

## DNS + HTTPS
- DNS A record: `api.salepilot.space` → VM public IP.
- Caddy fetches/renews the Let's Encrypt cert automatically (it retries until
  DNS resolves, so it self-heals once the record propagates).

## Frontend (Vercel)
Set the env var `VITE_API_URL=https://api.salepilot.space/api` on the Vercel
project and redeploy. Backend CORS already allows `salepilot.space`,
`www.salepilot.space` and `*.vercel.app`.

## Operations
```bash
# status / logs
docker ps
docker logs -f salepilot-backend
docker logs -f salepilot-caddy
# restart just the backend
docker compose -f docker-compose.prod.yml up -d --build s-back
# psql shell
docker exec -it salepilot-db psql -U postgres -d salepilot
# health (on the VM; backend is loopback-only besides Caddy)
curl -s http://127.0.0.1:5000/api/health
```

## Backups
- Nightly dump: `deploy/backup.sh` (cron: `0 2 * * * /home/ubuntu/salepilot/s-back/deploy/backup.sh >> /home/ubuntu/backups/backup.log 2>&1`).
  Keeps 14 days in `~/backups`; set `BUCKET=` inside for OCI Object Storage offsite copies.
- OCI Console: assign the **Bronze backup policy** to the boot volume.

## Notes / gotchas
- Postgres is not exposed publicly (no 5432 port mapping) — reach it only via
  `docker exec` or an SSH tunnel.
- The backend is `127.0.0.1:5000` on the VM for debugging; public traffic goes
  through Caddy only.
- Free-tier A1 capacity: if recreating the VM ever fails with "Out of
  capacity", retry off-peak or upgrade the account to Pay-As-You-Go (still $0
  within Always Free limits).
- Keep the account from looking idle (free-only accounts): the nightly backup
  cron plus real traffic is sufficient.
