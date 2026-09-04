[CmdletBinding(DefaultParameterSetName = 'Stage')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Stage')]
    [string] $ArchivePath,

    [Parameter(ParameterSetName = 'Stage')]
    [Parameter(ParameterSetName = 'Verify')]
    [string] $DestinationPath = (Join-Path $PSScriptRoot 'runtime/libvlc-3.0.23/win-x64'),

    [Parameter(Mandatory = $true, ParameterSetName = 'Verify')]
    [switch] $VerifyOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$pinnedArchiveSha256 = '992d19dbd0b8a7cde9167d2f7780b1ef6f92acc8a71acfa736101a21f35181e1'
$pinnedArchiveName = 'vlc-3.0.23-win64.zip'
$pinnedExtractedRoot = 'vlc-3.0.23'
$hashManifestName = 'runtime-files.sha256'
$maximumFiles = 10000
$maximumBytes = 1GB

function Get-NormalizedRelativePath {
    param(
        [Parameter(Mandatory = $true)] [string] $Root,
        [Parameter(Mandatory = $true)] [string] $Path
    )
    [IO.Path]::GetRelativePath($Root, $Path).Replace('\', '/')
}

function Assert-SafeRelativePath {
    param([Parameter(Mandatory = $true)] [string] $RelativePath)
    $parts = $RelativePath.Split('/')
    $reservedDevice = $parts | Where-Object {
        $stem = $_.Split('.')[0].ToUpperInvariant()
        $stem -in @('CON', 'PRN', 'AUX', 'NUL') -or $stem -match '^(COM|LPT)[1-9]$'
    }
    if ([string]::IsNullOrWhiteSpace($RelativePath) -or
        $RelativePath.Length -gt 512 -or
        [IO.Path]::IsPathRooted($RelativePath) -or
        $RelativePath.Contains('\') -or
        $RelativePath.Contains(':') -or
        $parts -contains '' -or
        $parts -contains '.' -or
        $parts -contains '..' -or
        ($parts | Where-Object { $_.EndsWith(' ') -or $_.EndsWith('.') }) -or
        $reservedDevice) {
        throw "Unsafe relative path in native-media package."
    }
}

function Test-StagedRuntime {
    param([Parameter(Mandatory = $true)] [string] $RuntimeRoot)

    $resolvedRoot = (Resolve-Path -LiteralPath $RuntimeRoot).Path
    $manifestPath = Join-Path $resolvedRoot $hashManifestName
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "The staged runtime hash manifest is missing."
    }
    $expected = @{}
    foreach ($line in [IO.File]::ReadAllLines($manifestPath, [Text.Encoding]::UTF8)) {
        if ($line.Length -eq 0) { continue }
        if ($line -notmatch '^([0-9a-f]{64}) \*(.+)$') {
            throw "The staged runtime hash manifest is malformed."
        }
        $relative = $Matches[2]
        Assert-SafeRelativePath -RelativePath $relative
        $folded = $relative.ToLowerInvariant()
        if ($expected.ContainsKey($folded)) {
            throw "The staged runtime hash manifest contains a duplicate path."
        }
        $expected[$folded] = @{ Relative = $relative; Hash = $Matches[1] }
    }
    if ($expected.Count -gt $maximumFiles) {
        throw "The staged runtime contains too many files."
    }
    foreach ($required in @('libvlc.dll', 'libvlccore.dll')) {
        if (-not $expected.ContainsKey($required)) {
            throw "The staged runtime is missing a required engine file."
        }
    }
    if (-not ($expected.Keys | Where-Object { $_.StartsWith('plugins/') -and $_.EndsWith('.dll') })) {
        throw "The staged runtime has no plugin library."
    }
    if (-not ($expected.Keys | Where-Object { [IO.Path]::GetFileName($_).StartsWith('copying') })) {
        throw "The staged runtime has no upstream license notice."
    }

    $files = @(Get-ChildItem -LiteralPath $resolvedRoot -Recurse -File | Where-Object {
        $_.FullName -ne $manifestPath
    })
    if ($files.Count -ne $expected.Count) {
        throw "The staged runtime has missing or unexpected files."
    }
    [UInt64] $totalBytes = 0
    foreach ($file in $files) {
        if ($file.LinkType) {
            throw "Links are forbidden in the staged runtime."
        }
        $relative = Get-NormalizedRelativePath -Root $resolvedRoot -Path $file.FullName
        Assert-SafeRelativePath -RelativePath $relative
        $folded = $relative.ToLowerInvariant()
        if (-not $expected.ContainsKey($folded) -or $expected[$folded].Relative -cne $relative) {
            throw "The staged runtime has an unexpected file."
        }
        $observed = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($observed -cne $expected[$folded].Hash) {
            throw "A staged runtime file failed its SHA-256 check."
        }
        $totalBytes += [UInt64] $file.Length
        if ($totalBytes -gt $maximumBytes) {
            throw "The staged runtime exceeds the one-gigabyte safety bound."
        }
    }
    [pscustomobject]@{
        RuntimeVersion = '3.0.23'
        Target = 'win-x64'
        FileCount = $files.Count
        ByteLength = $totalBytes
        Verified = $true
    }
}

if ($VerifyOnly) {
    Test-StagedRuntime -RuntimeRoot $DestinationPath
    return
}

$resolvedArchive = (Resolve-Path -LiteralPath $ArchivePath).Path
if (-not (Test-Path -LiteralPath $resolvedArchive -PathType Leaf)) {
    throw "The pinned libVLC archive is unavailable."
}
if ([IO.Path]::GetFileName($resolvedArchive) -cne $pinnedArchiveName) {
    throw "The archive filename does not match the pinned runtime."
}
$observedArchiveHash = (Get-FileHash -LiteralPath $resolvedArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($observedArchiveHash -cne $pinnedArchiveSha256) {
    throw "The libVLC archive SHA-256 does not match the checked-in pin."
}
if (Test-Path -LiteralPath $DestinationPath) {
    throw "The native-media destination already exists; refusing to replace it."
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("affect-research-libvlc-" + [Guid]::NewGuid().ToString('N'))
[void] (New-Item -ItemType Directory -Path $temporaryRoot)
try {
    $archive = [IO.Compression.ZipFile]::OpenRead($resolvedArchive)
    try {
        foreach ($entry in $archive.Entries) {
            $relative = $entry.FullName.Replace('\', '/').TrimEnd('/')
            if ($relative.Length -eq 0) { continue }
            Assert-SafeRelativePath -RelativePath $relative
        }
    }
    finally {
        $archive.Dispose()
    }
    [IO.Compression.ZipFile]::ExtractToDirectory($resolvedArchive, $temporaryRoot)
    $sourceRoot = Join-Path $temporaryRoot $pinnedExtractedRoot
    foreach ($required in @('libvlc.dll', 'libvlccore.dll', 'plugins')) {
        if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $required))) {
            throw "The pinned archive does not contain the expected libVLC runtime layout."
        }
    }
    $licenseFiles = @(Get-ChildItem -LiteralPath $sourceRoot -File -Filter 'COPYING*')
    if ($licenseFiles.Count -eq 0) {
        throw "The pinned archive does not contain an upstream COPYING notice."
    }

    $stagingRoot = Join-Path $temporaryRoot 'staged-runtime'
    [void] (New-Item -ItemType Directory -Path $stagingRoot)
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'libvlc.dll') -Destination $stagingRoot
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'libvlccore.dll') -Destination $stagingRoot
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'plugins') -Destination $stagingRoot -Recurse
    foreach ($license in $licenseFiles) {
        Copy-Item -LiteralPath $license.FullName -Destination $stagingRoot
    }

    $runtimeFiles = @(Get-ChildItem -LiteralPath $stagingRoot -Recurse -File | Sort-Object FullName)
    if ($runtimeFiles.Count -gt $maximumFiles) {
        throw "The staged runtime contains too many files."
    }
    $lines = foreach ($file in $runtimeFiles) {
        $relative = Get-NormalizedRelativePath -Root $stagingRoot -Path $file.FullName
        Assert-SafeRelativePath -RelativePath $relative
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash *$relative"
    }
    $manifestPath = Join-Path $stagingRoot $hashManifestName
    [IO.File]::WriteAllText(
        $manifestPath,
        (($lines -join "`n") + "`n"),
        [Text.UTF8Encoding]::new($false)
    )
    Test-StagedRuntime -RuntimeRoot $stagingRoot | Out-Null

    $destinationParent = Split-Path -Parent $DestinationPath
    [void] (New-Item -ItemType Directory -Path $destinationParent -Force)
    Move-Item -LiteralPath $stagingRoot -Destination $DestinationPath
    Test-StagedRuntime -RuntimeRoot $DestinationPath
}
finally {
    $resolvedTemporaryRoot = [IO.Path]::GetFullPath($temporaryRoot)
    $resolvedSystemTemporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedTemporaryRoot.StartsWith($resolvedSystemTemporary, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $resolvedTemporaryRoot)) {
        Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force
    }
}
