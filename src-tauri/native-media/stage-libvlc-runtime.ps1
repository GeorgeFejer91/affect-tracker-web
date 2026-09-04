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

$pinPath = Join-Path $PSScriptRoot 'libvlc-runtime-v1.json'
$pin = Get-Content -Raw -LiteralPath $pinPath | ConvertFrom-Json
if ($pin.schema -cne 'affect-research-native-media-runtime-pin' -or
    $pin.version -ne 1 -or
    $pin.backend -cne 'libvlc' -or
    $pin.runtimeVersion -cne '3.0.23' -or
    $pin.target -cne 'win-x64' -or
    $pin.runtimeTree.manifestOrdering -cne 'ordinal-relative-path-v1' -or
    $pin.runtimeTree.requiredPeMachine -cne '0x8664' -or
    $pin.runtimeTree.requiredOptionalHeaderMagic -cne '0x020b') {
    throw "The checked-in native-media pin is incompatible with this stager."
}
$pinnedArchiveSha256 = [string] $pin.archive.sha256
$pinnedArchiveName = [string] $pin.archive.fileName
$pinnedExtractedRoot = "vlc-$($pin.runtimeVersion)"
$hashManifestName = [string] $pin.runtimeTree.manifestFileName
$pinnedManifestSha256 = [string] $pin.runtimeTree.manifestSha256
$pinnedFileCount = [int] $pin.runtimeTree.fileCount
$pinnedByteLength = [UInt64] $pin.runtimeTree.byteLength
$maximumFiles = 10000
$maximumBytes = 1GB
$maximumDepth = 16

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

function Assert-OrdinaryFilesystemItem {
    param([Parameter(Mandatory = $true)] [IO.FileSystemInfo] $Item)

    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $Item.LinkType) {
        throw "Links and reparse points are forbidden in the staged runtime."
    }
}

function Get-OrdinaryRuntimeFiles {
    param([Parameter(Mandatory = $true)] [string] $RuntimeRoot)

    $rootItem = Get-Item -LiteralPath $RuntimeRoot -Force
    Assert-OrdinaryFilesystemItem -Item $rootItem
    if (-not $rootItem.PSIsContainer) {
        throw "The staged native runtime root is not an ordinary directory."
    }

    $pending = [Collections.Generic.Stack[object]]::new()
    $pending.Push([pscustomobject]@{ Path = $rootItem.FullName; Depth = 0 })
    $files = [Collections.Generic.List[IO.FileInfo]]::new()
    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        foreach ($item in @(Get-ChildItem -LiteralPath $current.Path -Force)) {
            Assert-OrdinaryFilesystemItem -Item $item
            if ($item.PSIsContainer) {
                $nextDepth = [int] $current.Depth + 1
                if ($nextDepth -gt $maximumDepth) {
                    throw "The staged runtime exceeds the supported folder depth."
                }
                $pending.Push([pscustomobject]@{ Path = $item.FullName; Depth = $nextDepth })
            }
            elseif ($item -is [IO.FileInfo]) {
                if ($files.Count -ge $maximumFiles) {
                    throw "The staged runtime contains too many files."
                }
                $files.Add($item)
            }
            else {
                throw "The staged runtime contains an unsupported filesystem item."
            }
        }
    }
    $files.ToArray()
}

function Assert-PeX64 {
    param([Parameter(Mandatory = $true)] [string] $Path)

    $stream = [IO.File]::Open(
        $Path,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::Read
    )
    try {
        if ($stream.Length -lt 64) {
            throw "A required engine file is not a valid PE image."
        }
        $reader = [IO.BinaryReader]::new($stream, [Text.Encoding]::ASCII, $true)
        try {
            if ($reader.ReadByte() -ne 0x4d -or $reader.ReadByte() -ne 0x5a) {
                throw "A required engine file is not a valid PE image."
            }
            $stream.Position = 0x3c
            [UInt64] $peOffset = $reader.ReadUInt32()
            if ($peOffset -lt 64 -or $peOffset + 26 -gt [UInt64] $stream.Length) {
                throw "A required engine file has an invalid PE header offset."
            }
            $stream.Position = [Int64] $peOffset
            if ($reader.ReadUInt32() -ne 0x00004550) {
                throw "A required engine file has an invalid PE signature."
            }
            $machine = $reader.ReadUInt16()
            $stream.Position = [Int64] ($peOffset + 20)
            $optionalHeaderBytes = $reader.ReadUInt16()
            if ($optionalHeaderBytes -lt 2) {
                throw "A required engine file has an invalid PE optional header."
            }
            $stream.Position = [Int64] ($peOffset + 24)
            $optionalMagic = $reader.ReadUInt16()
            if ($machine -ne 0x8664 -or $optionalMagic -ne 0x020b) {
                throw "A required engine file is not an x64 PE32+ image."
            }
        }
        finally {
            $reader.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Test-StagedRuntime {
    param([Parameter(Mandatory = $true)] [string] $RuntimeRoot)

    $rootItem = Get-Item -LiteralPath $RuntimeRoot -Force
    Assert-OrdinaryFilesystemItem -Item $rootItem
    if (-not $rootItem.PSIsContainer) {
        throw "The staged native runtime root is not an ordinary directory."
    }
    $resolvedRoot = $rootItem.FullName
    $manifestPath = Join-Path $resolvedRoot $hashManifestName
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "The staged runtime hash manifest is missing."
    }
    $manifestItem = Get-Item -LiteralPath $manifestPath -Force
    Assert-OrdinaryFilesystemItem -Item $manifestItem
    $observedManifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($observedManifestHash -cne $pinnedManifestSha256) {
        throw "The staged runtime tree identity does not match the checked-in pin."
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
    if ($expected.Count -ne $pinnedFileCount) {
        throw "The staged runtime file count does not match the checked-in pin."
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

    $files = @(Get-OrdinaryRuntimeFiles -RuntimeRoot $resolvedRoot | Where-Object {
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
    if ($totalBytes -ne $pinnedByteLength) {
        throw "The staged runtime byte length does not match the checked-in pin."
    }
    foreach ($required in @('libvlc.dll', 'libvlccore.dll')) {
        Assert-PeX64 -Path (Join-Path $resolvedRoot $required)
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

    $runtimeFiles = @(Get-OrdinaryRuntimeFiles -RuntimeRoot $stagingRoot)
    if ($runtimeFiles.Count -gt $maximumFiles) {
        throw "The staged runtime contains too many files."
    }
    $manifestEntries = [Collections.Generic.SortedDictionary[string, string]]::new(
        [StringComparer]::Ordinal
    )
    $caseFoldedPaths = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    foreach ($file in $runtimeFiles) {
        $relative = Get-NormalizedRelativePath -Root $stagingRoot -Path $file.FullName
        Assert-SafeRelativePath -RelativePath $relative
        if (-not $caseFoldedPaths.Add($relative)) {
            throw "The staged runtime contains a case-colliding path."
        }
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $manifestEntries.Add($relative, $hash)
    }
    $lines = foreach ($entry in $manifestEntries.GetEnumerator()) {
        "$($entry.Value) *$($entry.Key)"
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
