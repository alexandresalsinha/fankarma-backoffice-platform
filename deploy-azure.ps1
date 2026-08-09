# Deploy the Fanpage Karma backoffice to Azure App Service (Linux, Node 20).
# Prereqs: Azure CLI (`az`) installed and `az login` completed.

$ErrorActionPreference = "Stop"

# ── Config ────────────────────────────────────────────────────────────
$ResourceGroup = "F6-Development"
$Location      = "westeurope"
$PlanName      = "Linux-F6Development"
$Sku           = "P1mv3"                      # Free tier. Change to B1 for always-on / better SSE.
$BaseAppName   = "f6-development-fankarma-platform"
$Runtime       = "NODE:24-lts"

# Globally unique app name (base + 5 hex chars). Persisted so re-runs update
# the same Web App instead of creating a new one every time.
$stateFile = Join-Path $PSScriptRoot ".deploy-state.json"
if (Test-Path $stateFile) {
    $state   = Get-Content $stateFile -Raw | ConvertFrom-Json
    $AppName = $state.appName
    Write-Host "▶ Reusing existing app from .deploy-state.json" -ForegroundColor Cyan
} else {
    $suffix  = -join ((1..5) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
    $AppName = "$BaseAppName-$suffix"
    @{ appName = $AppName } | ConvertTo-Json | Set-Content -Path $stateFile -Encoding UTF8
}

Write-Host "▶ Target app name: $AppName" -ForegroundColor Cyan

# ── 0. Sanity checks ──────────────────────────────────────────────────
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI (az) not found on PATH. Install it first and run 'az login'."
}

$acct = az account show 2>$null | ConvertFrom-Json
if (-not $acct) { throw "Not logged in. Run 'az login' first." }
Write-Host "▶ Using subscription: $($acct.name) ($($acct.id))" -ForegroundColor Cyan

# ── 1. Resource group ─────────────────────────────────────────────────
Write-Host "▶ Creating resource group $ResourceGroup in $Location..." -ForegroundColor Cyan
az group create --name $ResourceGroup --location $Location --output none

# ── 2. App Service plan (Linux) ───────────────────────────────────────
Write-Host "▶ Creating App Service plan $PlanName ($Sku, Linux)..." -ForegroundColor Cyan
az appservice plan create `
    --name $PlanName `
    --resource-group $ResourceGroup `
    --location $Location `
    --sku $Sku `
    --is-linux `
    --output none

# ── 3. Web App ────────────────────────────────────────────────────────
Write-Host "▶ Creating Web App $AppName (Node 24 LTS)..." -ForegroundColor Cyan
az webapp create `
    --name $AppName `
    --resource-group $ResourceGroup `
    --plan $PlanName `
    --runtime $Runtime `
    --output none

# ── 4. App settings from .env (+ build flag) ─────────────────────────
Write-Host "▶ Reading .env and pushing values as App Settings..." -ForegroundColor Cyan
$envPath = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path $envPath)) { throw ".env not found at $envPath" }

$settings = @("SCM_DO_BUILD_DURING_DEPLOYMENT=true", "WEBSITE_NODE_DEFAULT_VERSION=~24")
foreach ($line in Get-Content $envPath) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith("#")) { continue }
    $eq = $t.IndexOf("=")
    if ($eq -lt 1) { continue }
    $key = $t.Substring(0, $eq).Trim()
    $val = $t.Substring($eq + 1).Trim()
    if ($key -ieq "PORT") { continue }   # App Service injects PORT automatically.
    $settings += "$key=$val"
}

az webapp config appsettings set `
    --name $AppName `
    --resource-group $ResourceGroup `
    --settings @settings `
    --output none

# ── 5. Ensure anonymous access (App Service Auth disabled) ───────────
az webapp auth update --name $AppName --resource-group $ResourceGroup --enabled false 2>$null | Out-Null

# ── 6. Build & upload zip ─────────────────────────────────────────────
$zipPath = Join-Path $PSScriptRoot "deploy.zip"
[GC]::Collect(); [GC]::WaitForPendingFinalizers()
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Write-Host "▶ Packaging app (POSIX paths; excluding node_modules, .env, .git)..." -ForegroundColor Cyan
Add-Type -AssemblyName System.IO.Compression.FileSystem

$topFiles = @("server.js", "package.json", "package-lock.json", ".deployment")
$topDirs  = @("lib", "public")
$entries  = @()
foreach ($f in $topFiles) {
    $src = Join-Path $PSScriptRoot $f
    if (Test-Path $src) { $entries += [PSCustomObject]@{ Src = $src; Rel = $f } }
}
foreach ($d in $topDirs) {
    $base = Join-Path $PSScriptRoot $d
    if (-not (Test-Path $base)) { continue }
    Get-ChildItem -Path $base -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($base.Length).TrimStart('\','/') -replace '\\','/'
        $entries += [PSCustomObject]@{ Src = $_.FullName; Rel = "$d/$rel" }
    }
}

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
    foreach ($e in $entries) {
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $e.Src, $e.Rel)
    }
}
finally {
    $zip.Dispose()
}

Write-Host "▶ Deploying zip (Oryx runs 'npm install' on the server)..." -ForegroundColor Cyan
az webapp deployment source config-zip `
    --resource-group $ResourceGroup `
    --name $AppName `
    --src $zipPath `
    --output none
if ($LASTEXITCODE -ne 0) { throw "Zip deployment failed (az exit $LASTEXITCODE)." }

# ── 7. Done ───────────────────────────────────────────────────────────
$url = "https://$AppName.azurewebsites.net"
Write-Host ""
Write-Host "✅ Deployed." -ForegroundColor Green
Write-Host "   URL:            $url"
Write-Host "   Resource group: $ResourceGroup"
Write-Host "   App name:       $AppName"
Write-Host ""
Write-Host "First load can take ~1 min on F1 (cold start + npm install)." -ForegroundColor Yellow
