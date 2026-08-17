# One-click: test -> commit -> push to GitHub and open source
# Usage (PowerShell):
#   .\scripts\publish-github.ps1 -RepoName dsh-dream-memory
# Requires gh installed and authenticated (gh auth login); repo must not exist on GitHub.

param(
  [string]$RepoName = "dsh-dream-memory",
  [switch]$Private
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

Write-Host "[1/4] Running tests..." -ForegroundColor Cyan
node --test tests\smoke.test.js
if ($LASTEXITCODE -ne 0) { throw "Tests failed, aborting release" }

Write-Host "[2/4] Initializing git..." -ForegroundColor Cyan
if (-not (Test-Path .git)) { git init -b main }
git add .

Write-Host "[3/4] Committing..." -ForegroundColor Cyan
git -c user.name="dsh-dream-memory" -c user.email="dsh-dream-memory@users.noreply.github.com" `
  commit -m "feat: dsh-dream-memory - SQLite + FTS5 + knowledge graph + dream consolidation memory plugin for DSH" `
  --allow-empty

Write-Host "[4/4] Creating GitHub repo and pushing..." -ForegroundColor Cyan
if ($Private) { $visibility = "--private" } else { $visibility = "--public" }
gh repo create $RepoName $visibility --source=. --remote=origin --push

Write-Host "Done: https://github.com/<your-username>/$RepoName" -ForegroundColor Green
