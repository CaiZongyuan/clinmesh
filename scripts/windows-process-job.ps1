param([string]$NodePath, [string]$BootstrapPath, [string]$Payload)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-process-job.cs')
  exit [ClinMeshProcessJob]::Run($NodePath, $BootstrapPath, $Payload)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
