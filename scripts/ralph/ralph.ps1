# Ralph Wiggum - Long-running Codex agent loop for PowerShell
# Usage: .\ralph.ps1 [-MaxIterations 10] [-ProjectRoot <path>] [-RalphDir <path>] [-Model <model>]

[CmdletBinding()]
param(
    [int]$MaxIterations = 10,
    [string]$ProjectRoot = (Get-Location).Path,
    [string]$RalphDir = $PSScriptRoot,
    [string]$Model = "",
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

if ($MaxIterations -lt 1 -and -not $DryRun) {
    throw "MaxIterations must be 1 or greater unless -DryRun is specified"
}

# Converts a Ralph branch name into a filesystem-safe feature folder name.
function Get-RalphFeatureName {
    param([string]$BranchName)

    $name = $BranchName -replace '^ralph/', ''
    $name = $name -replace '[^\w.-]+', '-'
    if ([string]::IsNullOrWhiteSpace($name)) {
        return "unknown-feature"
    }
    return $name
}

# Creates the progress log with a standard header when it does not already exist.
function Initialize-RalphProgress {
    param([string]$ProgressFile)

    if (-not (Test-Path -LiteralPath $ProgressFile)) {
        "# Ralph Progress Log" | Set-Content -LiteralPath $ProgressFile -Encoding UTF8
        "Started: $(Get-Date -Format o)" | Add-Content -LiteralPath $ProgressFile -Encoding UTF8
        "---" | Add-Content -LiteralPath $ProgressFile -Encoding UTF8
    }
}

# Reads and parses the Ralph PRD JSON file.
function Read-RalphPrd {
    param([string]$PrdFile)

    if (-not (Test-Path -LiteralPath $PrdFile)) {
        throw "Missing prd.json at $PrdFile"
    }

    return Get-Content -LiteralPath $PrdFile -Raw -Encoding UTF8 | ConvertFrom-Json
}

# Archives prior run state when the requested PRD branch changes.
function Invoke-RalphArchiveIfNeeded {
    param(
        [string]$PrdFile,
        [string]$ProgressFile,
        [string]$ArchiveDir,
        [string]$LastBranchFile
    )

    if (-not (Test-Path -LiteralPath $PrdFile)) {
        return
    }

    $prd = Read-RalphPrd -PrdFile $PrdFile
    $currentBranch = [string]($prd.branchName)
    if ([string]::IsNullOrWhiteSpace($currentBranch)) {
        return
    }

    $lastBranch = ""
    if (Test-Path -LiteralPath $LastBranchFile) {
        $lastBranch = (Get-Content -LiteralPath $LastBranchFile -Raw -Encoding UTF8).Trim()
    }

    if (-not [string]::IsNullOrWhiteSpace($lastBranch) -and $lastBranch -ne $currentBranch) {
        $date = Get-Date -Format "yyyy-MM-dd"
        $folderName = Get-RalphFeatureName -BranchName $lastBranch
        $archiveFolder = Join-Path $ArchiveDir "$date-$folderName"

        Write-Host "Archiving previous run: $lastBranch"
        New-Item -ItemType Directory -Force -Path $archiveFolder | Out-Null
        Copy-Item -LiteralPath $PrdFile -Destination (Join-Path $archiveFolder "prd.json") -Force
        if (Test-Path -LiteralPath $ProgressFile) {
            Copy-Item -LiteralPath $ProgressFile -Destination (Join-Path $archiveFolder "progress.txt") -Force
        }

        "# Ralph Progress Log" | Set-Content -LiteralPath $ProgressFile -Encoding UTF8
        "Started: $(Get-Date -Format o)" | Add-Content -LiteralPath $ProgressFile -Encoding UTF8
        "---" | Add-Content -LiteralPath $ProgressFile -Encoding UTF8
    }

    $currentBranch | Set-Content -LiteralPath $LastBranchFile -Encoding UTF8
}

# Builds the stable prompt prefix that should stay identical across runs for better prompt-cache reuse.
function New-RalphStablePromptPrefix {
    param([string]$CodexFile)

    $instructions = Get-Content -LiteralPath $CodexFile -Raw -Encoding UTF8
    return @"
Ralph Stable Instructions:
The following instructions are intentionally placed before runtime-specific values so repeated Ralph runs can share a stable prompt prefix. Keep project paths, iteration numbers, timestamps, log paths, and story-specific data out of this section.

$instructions
"@
}

# Builds the runtime-specific prompt tail for the current iteration.
function New-RalphDynamicPromptTail {
    param(
        [string]$ProjectRoot,
        [string]$ScriptDir,
        [string]$PrdFile,
        [string]$ProgressFile,
        [string]$LogFile
    )

    return @"

Ralph Runtime Context:
- Script directory: $ScriptDir
- PRD file: $PrdFile
- Progress file: $ProgressFile
- Log file: $LogFile
- Invocation working directory: $ProjectRoot
"@
}

# Builds the full prompt with stable instructions first and dynamic runtime context last.
function New-RalphPrompt {
    param(
        [string]$ProjectRoot,
        [string]$ScriptDir,
        [string]$PrdFile,
        [string]$ProgressFile,
        [string]$CodexFile,
        [string]$LogFile
    )

    $stablePrefix = New-RalphStablePromptPrefix -CodexFile $CodexFile
    $dynamicTail = New-RalphDynamicPromptTail -ProjectRoot $ProjectRoot -ScriptDir $ScriptDir -PrdFile $PrdFile -ProgressFile $ProgressFile -LogFile $LogFile
    return $stablePrefix + $dynamicTail
}

# Runs one non-interactive Codex CLI iteration and captures its output.
function Invoke-CodexIteration {
    param(
        [string]$ProjectRoot,
        [string]$ScriptDir,
        [string]$PrdFile,
        [string]$ProgressFile,
        [string]$CodexFile,
        [string]$LogFile,
        [string]$Model
    )

    $prompt = New-RalphPrompt -ProjectRoot $ProjectRoot -ScriptDir $ScriptDir -PrdFile $PrdFile -ProgressFile $ProgressFile -CodexFile $CodexFile -LogFile $LogFile
    $args = @(
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "-C",
        $ProjectRoot
    )

    if (-not [string]::IsNullOrWhiteSpace($Model)) {
        $args += @("-m", $Model)
    }

    $args += "-"
    $output = $prompt | & codex @args 2>&1
    $status = $LASTEXITCODE
    $output | Set-Content -LiteralPath $LogFile -Encoding UTF8
    if ($status -ne 0) {
        $output | Select-Object -Last 40 | ForEach-Object { Write-Host $_ }
    } else {
        $outputText = $output -join "`n"
        if ($outputText -match "<promise>COMPLETE</promise>") {
            Write-Host "<promise>COMPLETE</promise>"
        } else {
            Write-Host "Codex iteration completed. Full output saved to $LogFile"
        }
    }
    return ,([pscustomobject]@{
        Output = ($output -join "`n")
        ExitCode = $status
    })
}

# Returns true only when every PRD story is marked as passing.
function Test-RalphPrdComplete {
    param([string]$PrdFile)

    $prd = Read-RalphPrd -PrdFile $PrdFile
    $unfinished = @($prd.userStories | Where-Object { $_.passes -ne $true })
    return $unfinished.Count -eq 0
}

$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$RalphDir = (Resolve-Path -LiteralPath $RalphDir).Path
$PrdFile = Join-Path $RalphDir "prd.json"
$ProgressFile = Join-Path $RalphDir "progress.txt"
$ArchiveDir = Join-Path $RalphDir "archive"
$LastBranchFile = Join-Path $RalphDir ".last-branch"
$CodexFile = Join-Path $RalphDir "CODEX.md"
$RunsDir = Join-Path $RalphDir "runs"

if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
    throw "codex CLI is not available on PATH"
}

if (-not (Test-Path -LiteralPath $CodexFile)) {
    throw "Missing CODEX.md at $CodexFile"
}

if ($DryRun) {
    Write-Host "Starting Ralph - Tool: codex - Max iterations: $MaxIterations"
    Write-Host "Project root: $ProjectRoot"
    Write-Host "Ralph dir: $RalphDir"
    Write-Host "Dry run complete. No Ralph state was changed and no Codex iteration was started."
    exit 0
}

$null = Read-RalphPrd -PrdFile $PrdFile
Invoke-RalphArchiveIfNeeded -PrdFile $PrdFile -ProgressFile $ProgressFile -ArchiveDir $ArchiveDir -LastBranchFile $LastBranchFile
Initialize-RalphProgress -ProgressFile $ProgressFile
New-Item -ItemType Directory -Force -Path $RunsDir | Out-Null

Write-Host "Starting Ralph - Tool: codex - Max iterations: $MaxIterations"
Write-Host "Project root: $ProjectRoot"
Write-Host "Ralph dir: $RalphDir"

for ($i = 1; $i -le $MaxIterations; $i++) {
    Write-Host ""
    Write-Host "==============================================================="
    Write-Host "  Ralph Iteration $i of $MaxIterations (codex)"
    Write-Host "==============================================================="

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $logFile = Join-Path $RunsDir "$stamp-iteration-$i.log"
    $result = Invoke-CodexIteration -ProjectRoot $ProjectRoot -ScriptDir $RalphDir -PrdFile $PrdFile -ProgressFile $ProgressFile -CodexFile $CodexFile -LogFile $logFile -Model $Model

    if ($result.ExitCode -ne 0) {
        Write-Host "Codex iteration failed with exit code $($result.ExitCode)"
        exit $result.ExitCode
    }

    if ($result.Output -match "<promise>COMPLETE</promise>" -and (Test-RalphPrdComplete -PrdFile $PrdFile)) {
        Write-Host ""
        Write-Host "Ralph completed all tasks."
        Write-Host "Completed at iteration $i of $MaxIterations"
        exit 0
    }

    if ($result.Output -match "<promise>COMPLETE</promise>") {
        Write-Host "Codex emitted completion signal, but prd.json still has unfinished stories. Continuing..."
    }

    Write-Host "Iteration $i complete. Continuing..."
    Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "Ralph reached max iterations ($MaxIterations) without completing all tasks."
Write-Host "Check $ProgressFile for status."
exit 1
