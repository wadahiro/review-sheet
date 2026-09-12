// The scripts that put the folder back into the page.
//
// Dropping the folder works and is the fallback, but it is a gesture the
// recipient has to remember and repeat after every edit — and a page that shows
// what it was BUILT with until somebody drags something is a page that is
// usually wrong. These read the folder they are sitting in and write a
// `sheet.html` that carries it, so the ordinary act is a double-click.
//
// ONE file per platform, with the PowerShell inline. It was two — a `.bat`
// calling a `.ps1` — which is what `-File` requires, and `-File` is what
// PowerShell's execution policy governs: the split was solving a problem the
// split had created. `-Command` is not governed by it (the policy applies to
// script FILES), so a machine that refuses to run a `.ps1` will still run this.
//
// Still readable, which is the reason the split looked worth it: the command is
// built a line at a time and quoted with single quotes throughout, so a
// recipient can see what they are about to run without unpicking two levels of
// escaping. An encoded one-liner is what a corporate reader is trained to
// refuse, and would deserve it.
//
// NOT written in batch alone. It could be — `certutil` will base64 a file,
// which is the only part that needs encoding — but batch's own string handling
// drops empty lines, drops lines beginning `;`, truncates at 8191 characters,
// and breaks on a quote, a percent or an exclamation mark in the text. Every
// one of those is data-dependent and silent: a remark with a quote in it would
// lose a cell and nothing would say so.

const MARKER_OPEN = '<script type="application/json" id="sheet-md-set">';

export const UPDATE_MARKER_OPEN = MARKER_OPEN;

export const updateBat = (): string =>
  [
    "@echo off",
    "rem  Rebuild sheet.html from the files in this folder.",
    "rem  Double-click this after editing the .md files, then open sheet.html.",
    "rem",
    "rem  Nothing leaves this machine and nothing here is changed: viewer.html",
    "rem  and the markdown are read, sheet.html is written. The PowerShell below",
    "rem  is the whole of it — read it before you run it.",
    "setlocal",
    'cd /d "%~dp0"',
    "if not exist viewer.html (echo viewer.html is not in this folder. & pause & exit /b 1)",
    "",
    "rem  Built up a line at a time so it can be read. Passed with -Command,",
    "rem  which PowerShell's execution policy does not govern — that policy",
    "rem  applies to script FILES, and a machine that refuses one will still run",
    "rem  this. Single quotes throughout, so nothing here needs escaping twice.",
    "set \"PS=$ErrorActionPreference='Stop';\"",
    "set \"PS=%PS% $root=(Get-Location).Path;\"",
    "set \"PS=%PS% $skip=@('.html','.bat','.sh');\"",
    "set \"PS=%PS% $items=@(Get-ChildItem -Recurse -File | Where-Object { $skip -notcontains $_.Extension } |\"",
    "set \"PS=%PS%   ForEach-Object { [pscustomobject]@{\"",
    "set \"PS=%PS%     path=$_.FullName.Substring($root.Length+1).Replace([char]92,[char]47);\"",
    "set \"PS=%PS%     text=[IO.File]::ReadAllText($_.FullName,[Text.Encoding]::UTF8) } });\"",
    "set \"PS=%PS% if($items.Count -eq 0){ Write-Host 'No sheets in this folder.'; exit 1 };\"",
    "",
    "rem  A '<' anywhere in the text would end the script element early and the",
    "rem  rest of the page would become markup. Written \\u003c, which is the same",
    "rem  character to anything reading the JSON.",
    "set \"PS=%PS% $json=(ConvertTo-Json -InputObject $items -Depth 4 -Compress).Replace([string][char]60,'\\u003c');\"",
    "",
    "rem  The block is found by its id, not by the whole opening tag: an",
    "rem  attribute written in another order would otherwise be a tag this does",
    "rem  not recognise.",
    "set \"PS=%PS% $html=[IO.File]::ReadAllText('viewer.html',[Text.Encoding]::UTF8);\"",
    "set \"PS=%PS% $k=$html.IndexOf('sheet-md-set');\"",
    "set \"PS=%PS% if($k -lt 0){ Write-Host 'viewer.html does not take a folder - it was written by an older version.'; exit 1 };\"",
    "set \"PS=%PS% $from=$html.IndexOf([char]62,$k)+1;\"",
    "set \"PS=%PS% $to=$html.IndexOf('</script>',$from);\"",
    "set \"PS=%PS% $out=$html.Substring(0,$from)+[char]10+$json+[char]10+$html.Substring($to);\"",
    "set \"PS=%PS% [IO.File]::WriteAllText((Join-Path $root 'sheet.html'),$out,(New-Object Text.UTF8Encoding $false));\"",
    "set \"PS=%PS% Write-Host ('sheet.html written - {0} file(s).' -f $items.Count)\"",
    "",
    'powershell -NoProfile -Command "%PS%"',
    "pause",
    "",
  ].join("\r\n");

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

skip = (".html", ".bat", ".sh")
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
