# Install T3 Code from the Yarden-zamir/t3code fork on Windows. See docs/fork/operations.md "Install the fork".
#
#   irm https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install/install.ps1 | iex
#
# The script downloads the newest nightly installer from the fork releases and runs it.
# The app updates itself afterwards.
$ErrorActionPreference = "Stop"
$repo = "Yarden-zamir/t3code"

# The API lists releases newest first and includes pre-releases. GitHub "latest" skips them.
$releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=20" `
  -Headers @{ Accept = "application/vnd.github+json" }
$asset = $releases |
  ForEach-Object { $_.assets } |
  Where-Object { $_.name -like "*-x64.exe" } |
  Select-Object -First 1
if ($null -eq $asset) {
  throw "No Windows release found. Open https://github.com/$repo/releases"
}

$installer = Join-Path ([System.IO.Path]::GetTempPath()) $asset.name
Write-Host "t3 install: downloading $($asset.browser_download_url)"
# The progress bar of Invoke-WebRequest makes large downloads very slow in Windows PowerShell.
$ProgressPreference = "SilentlyContinue"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer
Write-Host "t3 install: running $($asset.name)"
Start-Process -FilePath $installer -Wait
Remove-Item $installer -ErrorAction SilentlyContinue

# K-602: this machine joins other machines through kitshn, not through T3.
Write-Host "t3 install: next, join this machine to kitshn: kitshn join <code> --server <address>"
