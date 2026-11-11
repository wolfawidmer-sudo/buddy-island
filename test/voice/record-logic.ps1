# Aufnahme-Logik fürs Cloud-Diktat (BuddyVosk.Step) ohne Mikrofon prüfen. Nicht im CI (braucht pwsh).
# Aufruf: node -e "process.stdout.write(require('./src/voice.js').SCRIPT)" > /tmp/v.ps1; pwsh -File test/voice/record-logic.ps1 /tmp/v.ps1
param([string]$script)
$ErrorActionPreference = 'Stop'
$src = Get-Content -Raw $script
$m = [regex]::Match($src, '\$voskCode = @"\r?\n([\s\S]*?)\r?\n"@')
Add-Type -TypeDefinition $m.Groups[1].Value -Language CSharp
$rnd = New-Object System.Random 7
function Buf([double]$amp, [string]$kind) {
  $b = New-Object byte[] 3200
  for ($i = 0; $i -lt 1600; $i++) {
    $v = 0
    if ($kind -eq 'tone') { $v = [int]($amp * [Math]::Sin($script:ph)); $script:ph += 0.39 }
    elseif ($kind -eq 'noise') { $v = [int](($rnd.NextDouble() * 2 - 1) * $amp * 1.7) }
    $v = [Math]::Max(-32768, [Math]::Min(32767, $v))
    $b[2 * $i] = [byte]($v -band 0xFF); $b[2 * $i + 1] = [byte](($v -shr 8) -band 0xFF)
  }
  return ,$b
}
$script:ph = 0.0
function Run($plan) {
  [BuddyVosk]::RecReset(30000, 1000, 6000)
  $t = 0
  foreach ($p in $plan) {
    for ($k = 0; $k -lt $p[0]; $k++) {
      $b = Buf $p[1] $p[2]
      $t += 100
      $r = [BuddyVosk]::Step($b, 3200)
      if ($r -and -not $r.StartsWith('P')) { return @($r, $t, [BuddyVosk]::RecPcm().Length) }
    }
  }
  return @('', $t, 0)
}
$fail = 0
function Check($name, $res, $state, $minT, $maxT) {
  $ok = ($res[0] -eq $state) -and ($res[1] -ge $minT) -and ($res[1] -le $maxT)
  if (-not $ok) { $script:fail++ }
  "{0} {1}: {2} nach {3} ms, PCM {4} Bytes" -f $(if ($ok) { 'ok ' } else { 'FEHLER' }), $name, $res[0], $res[1], $res[2]
}
Check 'Stille → nichts gesagt' (Run @(,@(80, 0, 'silence'))) 'T' 6000 6000
$r = Run @(@(5, 0, 'silence'), @(20, 5000, 'tone'), @(20, 0, 'silence'))
Check 'Sprechen, dann Pause' $r 'E' 3500 3600
if ($r[2] -lt 2.2 * 32000 -or $r[2] -gt 3.0 * 32000) { $fail++; "FEHLER Zuschnitt: $($r[2])" } else { 'ok  Zuschnitt: Stille vorne/hinten weg' }
Check 'Lüfter, Sprechen, Lüfter' (Run @(@(15, 400, 'noise'), @(20, 6000, 'tone'), @(20, 400, 'noise'))) 'E' 4500 4600
Check 'Nur Lüfter → nichts gesagt' (Run @(,@(80, 500, 'noise'))) 'T' 6000 6000
Check 'Dauerreden → 30 s' (Run @(,@(320, 5000, 'tone'))) 'M' 30000 30000
Check 'Kurze Pause beim Sprechen zählt nicht' (Run @(@(10, 5000, 'tone'), @(6, 0, 'silence'), @(10, 5000, 'tone'), @(12, 0, 'silence'))) 'E' 3600 3700
if ($fail) { "$fail Fehler"; exit 1 } else { 'Aufnahme-Logik ok' }
