// The scripts that put the folder back into the page.
//
// Dropping the folder works and is the fallback, but it is a gesture the
// recipient has to remember and repeat after every edit — and a page that shows
// what it was BUILT with until somebody drags something is a page that is
// usually wrong. These read the folder they are sitting in and write a
// `sheet.html` that carries it, so the ordinary act is a double-click.
//
// Two files rather than one long line: a recipient in a corporate environment
// is entitled to read what they are about to run, and an encoded one-liner is
// what they are trained to refuse. The `.bat` is three lines and the work is in
// the `.ps1` beside it.
//
// What can stop it is stated in the file itself: PowerShell's execution policy.
// `-ExecutionPolicy Bypass` covers the common case and a machine whose policy
// is set by Group Policy will still refuse — which is why the drop stays.

const MARKER_OPEN = '<script type="application/json" id="sheet-md-set">';

export const UPDATE_MARKER_OPEN = MARKER_OPEN;

export const updateBat = (): string =>
  [
    "@echo off",
    "rem  Rebuild sheet.html from the markdown in this folder.",
    "rem  Double-click this after editing the .md files.",
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"',
    "pause",
    "",
  ].join("\r\n");

export const updatePs1 = (): string =>
  `# Rebuild sheet.html from the files in this folder.
#
# Reads every file here except the pages and these scripts, puts them into
# viewer.html as one block, and writes sheet.html. Open that: it shows what the
# folder says now, with no folder to drag.
#
# Nothing leaves this machine and nothing here is changed: viewer.html and the
# markdown are read, sheet.html is written.

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path 'viewer.html')) { Write-Host 'viewer.html is not in this folder.'; exit 1 }

$root = (Get-Location).Path
$skip = @('.html', '.bat', '.ps1', '.sh')
$items = @(Get-ChildItem -Recurse -File | Where-Object { $skip -notcontains $_.Extension } | ForEach-Object {
  [pscustomobject]@{
    path = $_.FullName.Substring($root.Length + 1).Replace('\\', '/')
    text = [IO.File]::ReadAllText($_.FullName, [Text.Encoding]::UTF8)
  }
})

if ($items.Count -eq 0) { Write-Host 'No sheets in this folder.'; exit 1 }

# A '<' anywhere in the text would end the script element early and the rest of
# the page would become markup. Escaped as \\u003c, which is the same character
# to anything reading the JSON.
$json = (ConvertTo-Json -InputObject $items -Depth 4 -Compress) -replace '<', '\\u003c'

$html  = [IO.File]::ReadAllText('viewer.html', [Text.Encoding]::UTF8)
$open  = '${MARKER_OPEN}'
$at    = $html.IndexOf($open)
if ($at -lt 0) { Write-Host 'viewer.html does not take a folder — it was written by an older version.'; exit 1 }
$from  = $at + $open.Length
$to    = $html.IndexOf('</script>', $from)
$out   = $html.Substring(0, $from) + "\`n" + $json + "\`n" + $html.Substring($to)

[IO.File]::WriteAllText((Join-Path $root 'sheet.html'), $out, (New-Object Text.UTF8Encoding $false))
Write-Host ("sheet.html written — {0} file(s)." -f $items.Count)
`;

// The same thing, for a recipient who is not on Windows. Written in the shell
// every mac and every Linux has, with python3 for the JSON — building JSON by
// hand in shell is how a quote in a remark silently truncates a document.
export const updateSh = (): string =>
  `#!/bin/sh
# Rebuild sheet.html from the files in this folder.
#
# Reads every file here except the pages and these scripts, puts them into
# viewer.html as one block, and writes sheet.html. Open that: it shows what the
# folder says now, with no folder to drag.
set -eu
cd "$(dirname "$0")"
[ -f viewer.html ] || { echo "viewer.html is not in this folder."; exit 1; }
python3 - <<'PY'
import json, os, sys

skip = (".html", ".bat", ".ps1", ".sh")
items = []
for base, _dirs, names in os.walk("."):
    for n in sorted(names):
        p = os.path.normpath(os.path.join(base, n))
        if p.endswith(skip):
            continue
        with open(p, encoding="utf-8") as f:
            items.append({"path": p.replace(os.sep, "/"), "text": f.read()})

if not items:
    print("No sheets in this folder.")
    sys.exit(1)

# A '<' anywhere in the text would end the script element early and the rest of
# the page would become markup.
blob = json.dumps(items, ensure_ascii=False, separators=(",", ":")).replace("<", "\\\\u003c")

html = open("viewer.html", encoding="utf-8").read()
opening = ${JSON.stringify(MARKER_OPEN)}
at = html.find(opening)
if at < 0:
    print("viewer.html does not take a folder — it was written by an older version.")
    sys.exit(1)
start = at + len(opening)
end = html.find("</script>", start)
open("sheet.html", "w", encoding="utf-8").write(html[:start] + "\\n" + blob + "\\n" + html[end:])
print(f"sheet.html written — {len(items)} file(s).")
PY
`;
