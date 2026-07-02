# One-command production deploy: package s-back, ship to the OCI VM, rebuild.
#   .\deploy\deploy.ps1
# Excludes node_modules/dist/.git/uploads and NEVER touches the server's .env.
param(
    [string]$VmIp = "92.4.133.193",
    [string]$KeyPath = "$env:USERPROFILE\.ssh\oci_key.key"
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)   # ...\s-back
$parent = Split-Path -Parent $repoRoot                                # ...\salepilot (project root)
$tgz = Join-Path $env:TEMP "s-back-deploy.tgz"

Write-Host "[1/3] Packaging..." -ForegroundColor Cyan
tar -czf $tgz --exclude=node_modules --exclude=dist --exclude=.git --exclude=.env --exclude=uploads --exclude=docker-compose.yml -C $parent s-back
if ($LASTEXITCODE -ne 0) { throw "tar failed" }

Write-Host "[2/3] Uploading to $VmIp..." -ForegroundColor Cyan
scp -o ConnectTimeout=15 -i $KeyPath $tgz "ubuntu@${VmIp}:/home/ubuntu/s-back.tgz"
if ($LASTEXITCODE -ne 0) { throw "scp failed (network flap? just rerun)" }

Write-Host "[3/3] Rebuilding on the VM (npm install + tsc, be patient)..." -ForegroundColor Cyan
ssh -o ConnectTimeout=15 -i $KeyPath "ubuntu@${VmIp}" "tar -xzf ~/s-back.tgz -C ~/salepilot && cd ~/salepilot/s-back && sudo docker compose -f docker-compose.prod.yml up -d --build s-back 2>&1 | tail -4 && sleep 8 && curl -s -m 10 http://127.0.0.1:5000/api/health && echo '' && echo DEPLOY_OK"
if ($LASTEXITCODE -ne 0) { throw "remote build failed — check: ssh -i $KeyPath ubuntu@$VmIp 'sudo docker logs --tail 50 salepilot-backend'" }

Remove-Item $tgz -ErrorAction SilentlyContinue
Write-Host "Deployed. https://api.salepilot.space/api/health" -ForegroundColor Green
