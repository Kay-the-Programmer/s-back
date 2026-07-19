# Deploying the SalePilot backend on Google Cloud (Always Free e2-micro)

The canonical production guide. Targets **Google Cloud Compute Engine** with a
**$0/month** steady state inside GCP's permanent *Always Free* tier, so the $300
trial credit stays untouched as a reserve.

> **This is a fresh start.** The previous Oracle Cloud host is gone (account
> lockout; the VM is unreachable and its database + uploaded images could not be
> recovered). This guide therefore stands up a **brand-new, empty deployment** —
> `init_db` recreates the schema and re-seeds the superadmin on first boot. If
> you ever regain Oracle access, the only thing worth doing there is grabbing a
> `pg_dump` + an `uploads/` tar and restoring them here (see "Restoring old
> data" at the end).

> **How the trial credit really works.** The $300 credit expires **90 days after
> signup**, spent or not — you cannot stretch it to "last until you have users."
> The winning move is to run entirely inside the **Always Free** tier so your
> ongoing bill is ~$0, and treat the $300 as buffer. **Before day 90, upgrade
> the account to Pay-As-You-Go** — this does not start charging you, it just
> stops GCP from suspending the free-tier VM when the trial ends.

Target end state: one `e2-micro` VM running three containers
(`docker-compose.prod.yml`: Postgres + backend + Caddy), reachable at
`api.salepilot.space` over automatic HTTPS.

Facts that drive this guide:
- **Secrets live in `~/salepilot/s-back/.env`** (chmod 600, untracked). The git
  clone never creates it — you build it from `.env.production.example`.
- **The image is built on the VM** (`npm install` + `tsc` in the Dockerfile), so
  the CPU architecture doesn't matter — never copy prebuilt images, always
  rebuild.
- **1 GB RAM needs swap** or the Docker build gets OOM-killed (Phase 2a).

---

## Phase 0 — GCP account & project

1. Sign in to <https://console.cloud.google.com> with the Google account you
   want to **bill**. This can be any account — it is independent of the Firebase
   project `salepilot-ae09f` that powers Google sign-in (see "Firebase" below).
2. Activate the **$300 free trial** (needs a card for verification; it will not
   auto-charge).
3. Create a new project, e.g. **`salepilot-infra`** (purely for the VM).
4. Enable the **Compute Engine API** (the Console prompts on first VM create).

## Phase 1 — Provision the VM (stays $0 in Always Free)

**Region matters:** Always Free covers one `e2-micro` **only** in `us-west1`,
`us-central1`, or `us-east1`. Use `us-central1`.

Console → Compute Engine → **Create instance**:
- **Name:** `salepilot-prod`
- **Region/Zone:** `us-central1` / `us-central1-a`
- **Machine type:** `e2-micro` (2 shared vCPU, 1 GB) ← the free one
- **Boot disk:** Ubuntu **22.04 LTS**, **Standard persistent disk** (`pd-standard`),
  **30 GB**. *Do not pick SSD/Balanced — only `pd-standard` up to 30 GB is free.*
- **Firewall:** tick **Allow HTTP traffic** and **Allow HTTPS traffic**.
- Create.

Or with the `gcloud` CLI:
```bash
gcloud compute instances create salepilot-prod \
  --zone=us-central1-a \
  --machine-type=e2-micro \
  --image-family=ubuntu-2204-lts --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-standard \
  --tags=http-server,https-server
```

**Reserve a static IP** so DNS never breaks on reboot:
Console → VPC network → IP addresses → **Reserve external static address** →
region `us-central1` → attach to `salepilot-prod`. Note the IP — you point DNS
at it in Phase 5. (An in-use external IPv4 costs a few cents/day — negligible.)

> GCP Ubuntu images ship **no host firewall** that blocks ports. The "Allow
> HTTP/HTTPS" tags open 80/443 at the VPC level and SSH (22) is open by default,
> so there is **no `iptables` step** to do on the box. GCP also allows outbound
> 587/465 (only outbound 25 is blocked), so Gmail SMTP works here.

## Phase 2 — Base setup on the VM

SSH in (Console "SSH" button, or `gcloud compute ssh salepilot-prod --zone=us-central1-a`).

**2a. Swap — do this before anything else.** 1 GB RAM can't `npm install` +
`tsc` during the Docker build; without swap the build gets OOM-killed:
```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h   # confirm Swap: 4.0Gi
```

**2b. Docker:**
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker   # or log out/in
```

**2c. Clone the repo** (layout `~/salepilot/s-back`):
```bash
mkdir -p ~/salepilot && cd ~/salepilot
git clone https://github.com/Kay-the-Programmer/s-back.git s-back
cd s-back
```

## Phase 3 — Build the `.env` (all secrets go here)

There is no old `.env` to copy — the Oracle one was lost with the VM. Create a
fresh one from the template and fill in every value:
```bash
cp .env.production.example .env
chmod 600 .env
nano .env
```

Where each critical value comes from:

| Var | Where to get it |
|---|---|
| `API_DOMAIN` | `api.salepilot.space` |
| `FRONTEND_URL` | `https://www.salepilot.space` |
| `POSTGRES_PASSWORD` | Generate new: `openssl rand -hex 24` |
| `JWT_SECRET` | Generate new: `openssl rand -hex 32` |
| `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` | Your choice — seeded on first boot only |
| `FIREBASE_SERVICE_ACCOUNT` | Firebase Console (`salepilot-ae09f`) → Project Settings → Service Accounts → **Generate new private key** → paste the JSON as a single-line string |
| `FIREBASE_*` (web config) | Firebase Console → Project Settings → General (defaults already in `src/firebase.ts`) |
| `SMTP_*` | Your Gmail address + a Google **App Password** (not your login password) |
| `LENCO_SECRET_KEY` | Lenco dashboard |
| `GOOGLE_AI_API_KEY` / `API_KEY` | Google AI Studio — **rotate the old Gemini key**, it was exposed |
| WhatsApp / Facebook / Africa's Talking | Their respective dashboards |

Leave optional integrations blank to disable them; the app boots fine without.

## Phase 4 — Launch the stack

```bash
cd ~/salepilot/s-back
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
```
On first boot, `init_db` creates the schema and seeds the superadmin.

**Health check on the box** (DNS may still point at the dead old IP — test locally):
```bash
curl -s http://127.0.0.1:5000/api/health
docker logs --tail 50 salepilot-backend
```
Caddy can't obtain a cert until DNS points here — that's expected until Phase 5.

## Phase 5 — Point DNS and go live

Your API is currently **down** (the old host is offline), so this restores
service rather than a zero-downtime cutover:

1. At your DNS provider, set the **A record** for `api.salepilot.space` to the
   **GCP static IP** from Phase 1 (replacing the old, dead `92.4.133.193`).
2. Watch Caddy fetch the cert automatically:
   ```bash
   docker logs -f salepilot-caddy   # look for "certificate obtained successfully"
   ```
3. From your laptop once DNS propagates:
   `curl -s https://api.salepilot.space/api/health` → healthy.
4. Smoke-test end to end: log in as the superadmin, create a store/product, run
   one sale.

Frontend needs no change — Vercel already targets
`https://api.salepilot.space/api`, which now resolves to GCP.

## Phase 6 — Backups & guardrails

**Backups** (`deploy/backup.sh` dumps Postgres + tars `uploads/`, 14-day local
retention):
```bash
mkdir -p ~/backups
crontab -e
# add:
0 2 * * * /home/$USER/salepilot/s-back/deploy/backup.sh >> /home/$USER/backups/backup.log 2>&1
```
**Set up offsite copies this time** — local-only backups are exactly what left
you stranded. Create a **GCS bucket** (5 GB Always Free in a US region) and set
`BUCKET=` in the script's environment; it will `gsutil cp` each dump off the VM.

**Budget alert (do this now):** Billing → Budgets & alerts → thresholds at
$1 / $20 / $50 with email alerts.

**Before day 90:** Billing → **upgrade to Pay-As-You-Go** so the free-tier VM
isn't suspended when the trial credit expires. Inside free limits the bill stays
$0.

## Redeploys after go-live (git-based)

```powershell
# dev machine: commit + push to main
git add -A ; git commit -m "..." ; git push
```
```bash
# GCP VM
~/salepilot/s-back/deploy/pull-and-rebuild.sh   # prints DEPLOY_OK — running commit: <sha>
```

## Restoring old data (only if you regain Oracle access)

If Oracle reinstates the account and the VM's disk survives:
```bash
# on the recovered Oracle VM
docker exec salepilot-db pg_dump -U postgres salepilot | gzip > ~/rescue.sql.gz
tar -czf ~/rescue-uploads.tar.gz -C ~/salepilot/s-back uploads public/images
# download both, then upload to the GCP VM and restore:
gunzip -c rescue.sql.gz | docker exec -i salepilot-db psql -U postgres -d salepilot
tar -xzf rescue-uploads.tar.gz -C ~/salepilot/s-back
docker compose -f docker-compose.prod.yml restart s-back
```

## Cost cheatsheet — free vs. billed

| Choice | Free? |
|---|---|
| 1× `e2-micro` in us-central1/us-west1/us-east1 | ✅ Always Free |
| 30 GB `pd-standard` boot disk | ✅ Always Free |
| Caddy on the VM for HTTPS | ✅ (no Load Balancer) |
| Postgres in a container on the VM | ✅ (no Cloud SQL) |
| In-use static external IPv4 | ~a few cents/day |
| **Cloud SQL** | ❌ $9–50+/mo — never use it here |
| **Load Balancer** | ❌ ~$18/mo — Caddy replaces it |
| VM bigger than `e2-micro` (e.g. `e2-small`) | ❌ billed hourly (credit covers it for 90 days) |

**If `e2-micro` feels starved** under real users: bump to `e2-small` (2 GB,
~$12/mo) — the credit absorbs it during the trial. Downsize back before day 90
to return to $0.

## Firebase / Google sign-in — no change needed

The backend authenticates to Firebase (`salepilot-ae09f`) with the service
account key in `FIREBASE_SERVICE_ACCOUNT`. That credential is portable and
account-independent, so Google sign-in works regardless of which GCP account
owns this VM. The frontend "Login with Google" OAuth client also lives in the
Firebase project and is tied to your frontend domain, not the backend host.
