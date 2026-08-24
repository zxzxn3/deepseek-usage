# package.ps1 - Build and package the DeepSeek Usage extension into a .vsix.
# Usage: powershell -ExecutionPolicy Bypass -File .\package.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# Remove stale artifacts
Get-ChildItem -Path . -Filter "deepseek-usage-*.vsix" -File -ErrorAction SilentlyContinue |
    Remove-Item -Force

# Package. vsce automatically runs vscode:prepublish (production build).
npx -y @vscode/vsce package -o deepseek-status-bar-for-copilot.vsix
if ($LASTEXITCODE -ne 0) {
    throw "vsce package failed (exit code $LASTEXITCODE)"
}

Write-Host "Packaged:"
Get-ChildItem -Path . -Filter "deepseek-usage-*.vsix" -File |
    Select-Object -ExpandProperty Name
