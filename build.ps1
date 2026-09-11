param(
    [Parameter(Mandatory=$true)]
    [string]$ServerLib,

    # Either the original websupport-1.0.3.zip, or an already-extracted
    # folder containing oie-webadmin.war and websupport-shared.jar (with or
    # without the extra "websupport\" nesting level the real zip has).
    [Parameter(Mandatory=$true)]
    [string]$WebSupportSource
)

# Builds websupport_with_flow-1.0.0.zip: Web Support's own files, copied
# through unmodified, plus Message Flow's compiled classes merged into one
# shared jar, plus the webadmin/ folder that turns Message Flow into a nav
# tab inside the Web Support shell instead of its own separately-deployed
# page.
#
# Usage:
#   .\build.ps1 -ServerLib "C:\Program Files\OpenIntegrationEngine\server-lib" -WebSupportSource "C:\path\to\websupport-1_0_3.zip"

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not (Test-Path $ServerLib)) {
    Write-Error "SERVER_LIB folder not found: $ServerLib"
    exit 1
}
if (-not (Get-Command javac -ErrorAction SilentlyContinue)) {
    Write-Error "javac was not found on PATH. You need a JDK (not just a JRE) to compile. Mirth/OIE ships its own bundled JRE to RUN the engine - that's separate from a JDK you'd install for building extensions. Install a JDK 17+ and try again."
    exit 1
}
if (-not (Test-Path $WebSupportSource)) {
    Write-Error "WebSupportSource not found: $WebSupportSource"
    exit 1
}

$work = Join-Path $PSScriptRoot "build"
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Path "$work\classes" -Force | Out-Null

# --- Locate websupport's own files (unzip if given a .zip) -----------------

function Find-WebSupportFiles($root) {
    $war = Get-ChildItem -Path $root -Recurse -Filter "oie-webadmin.war" | Select-Object -First 1
    $jar = Get-ChildItem -Path $root -Recurse -Filter "websupport-shared.jar" | Select-Object -First 1
    return @{ War = $war; Jar = $jar }
}

$webSupportRoot = $WebSupportSource
if ((Get-Item $WebSupportSource).PSIsContainer -eq $false) {
    Write-Host "Extracting $WebSupportSource ..."
    $webSupportRoot = "$work\websupport-extracted"
    New-Item -ItemType Directory -Path $webSupportRoot -Force | Out-Null
    [System.IO.Compression.ZipFile]::ExtractToDirectory($WebSupportSource, $webSupportRoot)
}

$wsFiles = Find-WebSupportFiles $webSupportRoot
if (-not $wsFiles.War -or -not $wsFiles.Jar) {
    Write-Error "Could not find oie-webadmin.war and websupport-shared.jar under $webSupportRoot -- is this really the websupport zip/folder?"
    exit 1
}
Write-Host "Found oie-webadmin.war: $($wsFiles.War.FullName)"
Write-Host "Found websupport-shared.jar: $($wsFiles.Jar.FullName)"

# --- Compile Message Flow's Java sources ------------------------------------

Write-Host "Finding jars under $ServerLib ..."
$jars = @(Get-ChildItem -Path $ServerLib -Recurse -Filter *.jar | ForEach-Object { $_.FullName })
if ($jars.Count -eq 0) {
    Write-Error "No jars found under $ServerLib - check the path."
    exit 1
}
Write-Host "Found $($jars.Count) jars."

Write-Host "Finding source files ..."
$sources = @(Get-ChildItem -Path "$PSScriptRoot\src" -Recurse -Filter *.java | ForEach-Object { $_.FullName })
if ($sources.Count -eq 0) {
    Write-Error "No .java files found under src\ - is this the right folder?"
    exit 1
}
Write-Host "Found $($sources.Count) source files."

# javac argfile (not a single command line): avoids cmd.exe's ~8191-char
# command-line limit, and uses forward slashes throughout, since javac's
# argfile format treats backslashes inside quoted tokens as escape
# characters and would otherwise mangle plain Windows paths.
function ToSlashes($p) { $p -replace '\\', '/' }

$argfilePath = "$work\javac-args.txt"
$classesDirSlash = ToSlashes "$work\classes"
$classpathSlash = ($jars | ForEach-Object { ToSlashes $_ }) -join ";"
$argLines = @("-encoding", "UTF-8", "-d", "`"$classesDirSlash`"", "-cp", "`"$classpathSlash`"") + ($sources | ForEach-Object { "`"$(ToSlashes $_)`"" })
Set-Content -Path $argfilePath -Value $argLines -Encoding ASCII

Write-Host "Compiling..."
& javac "@$argfilePath"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Compilation failed - see errors above."
    exit 1
}

# --- Merge websupport-shared.jar's classes with our own compiled classes ---

Write-Host "Merging classes into websupport_with_flow-shared.jar ..."
$combined = "$work\classes-combined"
New-Item -ItemType Directory -Path $combined -Force | Out-Null
[System.IO.Compression.ZipFile]::ExtractToDirectory($wsFiles.Jar.FullName, $combined)
Copy-Item "$work\classes\*" $combined -Recurse -Force

Push-Location $combined
& jar --create --file "$work\websupport_with_flow-shared.jar" .
Pop-Location
if ($LASTEXITCODE -ne 0) {
    Write-Error "jar packaging failed - see errors above."
    exit 1
}

# --- Stage everything -------------------------------------------------------

Write-Host "Staging files ..."
$stage = "$work\stage\websupport_with_flow"
if (Test-Path "$work\stage") { Remove-Item -Recurse -Force "$work\stage" }
New-Item -ItemType Directory -Path "$stage\webadmin\web" -Force | Out-Null

Copy-Item "$PSScriptRoot\plugin.xml" "$stage\plugin.xml" -Force
Copy-Item "$work\websupport_with_flow-shared.jar" "$stage\websupport_with_flow-shared.jar" -Force
Copy-Item $wsFiles.War.FullName "$stage\oie-webadmin.war" -Force
Copy-Item "$PSScriptRoot\webadmin\plugin.json" "$stage\webadmin\plugin.json" -Force
Copy-Item "$PSScriptRoot\webadmin\web\plugin.js" "$stage\webadmin\web\plugin.js" -Force

# --- Zip, with explicit directory entries at every level -------------------
#
# NOT Compress-Archive: it's well known to omit explicit directory entries
# (only listing full file paths), and the engine's extension installer
# needs one at EVERY level of nesting to create that folder before writing
# files into it -- this bit us before with a flat one-level folder, and
# this package has two extra levels (webadmin\, webadmin\web\), so it
# matters even more here. Build the zip by hand with .NET's ZipArchive,
# walking the staged tree and adding an explicit entry for every directory
# as well as every file.

$outZip = "$PSScriptRoot\websupport_with_flow-1.0.0.zip"
if (Test-Path $outZip) { Remove-Item -Force $outZip }

$fs = [System.IO.File]::Open($outZip, [System.IO.FileMode]::Create)
try {
    $archive = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $stageParent = Split-Path $stage -Parent
        $allDirs = Get-ChildItem -Path $stage -Recurse -Directory
        $allDirs = @($stage) + @($allDirs.FullName) # include the root "websupport_with_flow" folder itself
        foreach ($dir in $allDirs) {
            $rel = $dir.Substring($stageParent.Length + 1).Replace('\', '/')
            $archive.CreateEntry("$rel/") | Out-Null
        }
        $allFiles = Get-ChildItem -Path $stage -Recurse -File
        foreach ($file in $allFiles) {
            $rel = $file.FullName.Substring($stageParent.Length + 1).Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $file.FullName, $rel,
                [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally {
        $archive.Dispose()
    }
} finally {
    $fs.Dispose()
}

Write-Host ""
Write-Host "Done: $outZip"
Write-Host "Install it from the engine Administrator's Extensions page (Browse... / Install)."
Write-Host "If Web Support (or the old standalone Message Flow) is already installed, remove it first --"
Write-Host "this package replaces both. Restart the engine, then open the Web Support webadmin and"
Write-Host "look for the new 'Message Flow' item under the Monitor section of the left rail."
