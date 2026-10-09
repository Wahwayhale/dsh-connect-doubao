$ErrorActionPreference = 'Stop'
$tok = $args[0]
$base = if ($args[1]) { $args[1] } else { 'http://127.0.0.1:19413' }
$r = Invoke-WebRequest -Uri "$base/?token=$tok" -UseBasicParsing -TimeoutSec 30
$h = $r.Content
$at = $h.IndexOf('globalThis["__DSH_BOOT__"] = ')
if ($at -lt 0) { Write-Output 'BOOT NOT FOUND'; exit 1 }
$start = $h.IndexOf('{', $at)
$depth = 0; $end = -1
for ($i = $start; $i -lt $h.Length; $i++) {
  $ch = $h[$i]
  if ($ch -eq '{') { $depth++ }
  elseif ($ch -eq '}') { $depth--; if ($depth -eq 0) { $end = $i + 1; break } }
}
$json = $h.Substring($start, $end - $start)
$boot = $json | ConvertFrom-Json
$entries = @($boot.entries)
Write-Output "top-level keys : $($boot.PSObject.Properties.Name -join ', ')"
Write-Output "total entries  : $($entries.Count)"
foreach ($id in @('dsh-connect-doubao','dsh-connect-workbuddy','dsh-connect-trae')) {
  $e = $entries | Where-Object { $_.id -eq $id } | Select-Object -First 1
  Write-Output ""
  Write-Output "=== $id ==="
  if ($null -eq $e) { Write-Output "  ABSENT from boot manifest"; continue }
  Write-Output ($e | ConvertTo-Json -Depth 5)
}
Write-Output ""
Write-Output "=== entries injecting dsh-client-ui-settings ==="
$entries | Where-Object { $_.inject -contains '@deepseek-ai/dsh-client-ui-settings' } | ForEach-Object { "  $($_.id)  immediately=$($_.immediately)" }
Write-Output ""
Write-Output "=== index position ==="
for ($i=0; $i -lt $entries.Count; $i++) { if ($entries[$i].id -match 'doubao|workbuddy|trae') { Write-Output "  [$i] $($entries[$i].id)" } }