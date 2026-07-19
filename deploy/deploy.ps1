# One-command production deploy: package s-back, ship to the production VM, rebuild.
#   .\deploy\deploy.ps1 -VmIp <gcp-static-ip>
# Excludes node_modules/dist/.git/uploads and NEVER touches the server's .env.
# Requires your SSH key to be on the VM (gcloud adds it on first `gcloud compute ssh`).
# The git-based deploy (deploy/pull-and-rebuild.sh on the VM) is the primary path.
param(
    [Parameter(Mandatory = $true)][string]$VmIp,
    [string]$SshUser = "ubuntu",
    [string]$KeyPath = "$env:USERPROFILE\.ssh\gcp_key"
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)   # ...\s-back
$parent = Split-Path -Parent $repoRoot                                # ...\salepilot (project root)
$tgz = Join-Path $env:TEMP "s-back-deploy.tgz"

Write-Host "[1/3] Packaging..." -ForegroundColor Cyan
tar -czf $tgz --exclude=node_modules --exclude=dist --exclude=.git --exclude=.env --exclude=uploads --exclude=docker-compose.yml -C $parent s-back
if ($LASTEXITCODE -ne 0) { throw "tar failed" }

Write-Host "[2/3] Uploading to $VmIp..." -ForegroundColor Cyan
scp -o ConnectTimeout=15 -i $KeyPath $tgz "${SshUser}@${VmIp}:~/s-back.tgz"
if ($LASTEXITCODE -ne 0) { throw "scp failed (network flap? just rerun)" }

Write-Host "[3/3] Rebuilding on the VM (npm install + tsc, be patient)..." -ForegroundColor Cyan
ssh -o ConnectTimeout=15 -i $KeyPath "${SshUser}@${VmIp}" "tar -xzf ~/s-back.tgz -C ~/salepilot && cd ~/salepilot/s-back && sudo docker compose -f docker-compose.prod.yml up -d --build s-back 2>&1 | tail -4 && sleep 8 && curl -s -m 10 http://127.0.0.1:5000/api/health && echo '' && echo DEPLOY_OK"
if ($LASTEXITCODE -ne 0) { throw "remote build failed — check: ssh -i $KeyPath ${SshUser}@$VmIp 'sudo docker logs --tail 50 salepilot-backend'" }

Remove-Item $tgz -ErrorAction SilentlyContinue
Write-Host "Deployed. https://api.salepilot.space/api/health" -ForegroundColor Green
