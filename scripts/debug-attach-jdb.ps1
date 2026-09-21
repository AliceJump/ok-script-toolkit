#Requires -Version 5.1
<#
.SYNOPSIS
    零扩展地把调试器附加到沙箱 IDE 的 JDWP 端口（默认 5005）。

.DESCRIPTION
    **为什么需要它**：VS Code **内置的调试类型里没有 JDWP** —— 只有
    `node` / `chrome` / `msedge` / `extensionHost` / `mock`。`"type": "java"` 属于
    `vscjava.vscode-java-debug` 扩展，不装就会报「无法识别此调试类型」。
    而 `jdb` 随 JDK 一起提供，所以这条路**不需要安装任何扩展**。

    配合的启动任务：`插件·调试沙箱 IDE（子仓库 JetBrains 插件，5005 等待附加）`
    （即 `gradlew runIde --debug-jvm`）—— 它会以 `suspend=y` 起沙箱 IDE，
    等调试器附加后才继续启动。

    ⚠️ **三个实测踩过的坑，改这个脚本时别踩回去**：
    1. `jdb -attach <host>:<port>` 在 **Windows 上会选 shmem 连接器并直接失败**
       （`shmemBase_attach failed`）。必须显式指定 socket 连接器：
       `-connect com.sun.jdi.SocketAttach:hostname=...,port=...`
    2. **`jdb` 不一定在 PATH 上** —— 本仓库的 JDK 是 Gradle 用 `jvmToolchain(21)`
       自动下载到 `~/.gradle/jdks/` 的，所以脚本要自己找。
    3. 沙箱 IDE 以 `suspend=y` 启动，**附加后会停在「当前调用堆栈上没有帧」**，
       必须输入 `cont` 它才会继续启动 —— 脚本会把这句话打在屏幕上。

.PARAMETER Port
    调试端口，默认 5005（与 `gradlew runIde --debug-jvm` 的默认端口一致）。

.PARAMETER HostName
    目标主机，默认 localhost。

.EXAMPLE
    powershell -NoProfile -File scripts/debug-attach-jdb.ps1
.EXAMPLE
    powershell -NoProfile -File scripts/debug-attach-jdb.ps1 -Port 5006
#>
[CmdletBinding()]
param(
    [int]$Port = 5005,
    [string]$HostName = 'localhost'
)

$ErrorActionPreference = 'Stop'

# 退出码刻意分开，便于脚本化调用时区分失败原因：
#   1 = 找不到 jdb
#   2 = 端口没人监听（沙箱 IDE 没起来）
#   其它 = jdb 自己返回的码

function Find-Jdb {
    # 1) PATH
    $cmd = Get-Command jdb.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    # 2) JAVA_HOME
    if ($env:JAVA_HOME) {
        $p = Join-Path $env:JAVA_HOME 'bin\jdb.exe'
        if (Test-Path $p) { return $p }
    }

    # 3) Gradle 自动下载的 toolchain（本仓库 `jvmToolchain(21)` 就是走这条）
    $roots = New-Object System.Collections.ArrayList
    if ($env:USERPROFILE) { [void]$roots.Add((Join-Path $env:USERPROFILE '.gradle\jdks')) }
    if ($env:GRADLE_USER_HOME) { [void]$roots.Add((Join-Path $env:GRADLE_USER_HOME 'jdks')) }

    # 4) 常见 JDK 安装位置（含 D:\env_all\<jdk> 这种自建目录）
    foreach ($r in @('C:\Program Files\Java', 'C:\Program Files\Eclipse Adoptium', 'C:\Program Files\Microsoft', 'D:\env_all')) {
        [void]$roots.Add($r)
    }

    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        $hit = Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName 'bin\jdb.exe' } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
        if ($hit) { return $hit }
    }
    return $null
}

function Test-DebugPort {
    param([string]$Target, [int]$TargetPort)
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect($Target, $TargetPort, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(800)) { $client.Close(); return $false }
        $client.EndConnect($async)
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

# ── 1. 找 jdb ────────────────────────────────────────────────────────
$jdb = Find-Jdb
if (-not $jdb) {
    Write-Host '[x] 找不到 jdb.exe。' -ForegroundColor Red
    Write-Host '    它随 JDK 提供。装了 JDK 却仍找不到时，把 JDK 的 bin 加进 PATH，' -ForegroundColor Yellow
    Write-Host '    或设置 JAVA_HOME 后重跑。' -ForegroundColor Yellow
    exit 1
}
Write-Host "[i] jdb: $jdb" -ForegroundColor DarkGray

# ── 2. 先确认端口有人监听（否则给一句人话，而不是 jdb 那串英文栈）─────
if (-not (Test-DebugPort -Target $HostName -TargetPort $Port)) {
    Write-Host "[x] $HostName`:$Port 没有在监听 —— 沙箱 IDE 还没起来。" -ForegroundColor Red
    Write-Host '    先在 VS Code 里跑任务「插件·调试沙箱 IDE（子仓库 JetBrains 插件，5005 等待附加）」，' -ForegroundColor Yellow
    Write-Host '    等它打印 "Listening for transport dt_socket" 之后，再跑本脚本。' -ForegroundColor Yellow
    exit 2
}

# ── 3. 常用命令速查（jdb 自带的 help 太简，而这些是实际要用的）────────
Write-Host ''
Write-Host '──────────────── jdb 常用命令（附加后在这个终端里输入）────────────────' -ForegroundColor Cyan
Write-Host '  cont                     继续运行。**附加后先输这个** —— 沙箱 IDE 是' -ForegroundColor White
Write-Host '                           suspend=y 起来的，会停在「当前调用堆栈上没有帧」' -ForegroundColor DarkGray
Write-Host '  stop in <类>.<方法>        方法断点，例：' -ForegroundColor White
Write-Host '                             stop in com.alicejump.okscripttoolkit.core.OkProjectDataService.refresh' -ForegroundColor DarkGray
Write-Host '  stop at <类>:<行号>        行断点，例：' -ForegroundColor White
Write-Host '                             stop at com.alicejump.okscripttoolkit.ui.TemplatesToolWindowFactory:93' -ForegroundColor DarkGray
Write-Host '  clear <类>:<行号>         删掉断点（清全部用 clear）' -ForegroundColor White
Write-Host '  where                    当前堆栈（where all 看所有线程）' -ForegroundColor White
Write-Host '  locals / print <表达式>    看局部变量 / 求值' -ForegroundColor White
Write-Host '  list                     当前行附近的源码' -ForegroundColor White
Write-Host '  next / step / step up    单步跳过 / 进入 / 跳出' -ForegroundColor White
Write-Host '  quit                     断开（沙箱 IDE 继续跑，不会被杀）' -ForegroundColor White
Write-Host '──────────────────────────────────────────────────────────────────' -ForegroundColor Cyan
Write-Host ''

# ── 4. 附加 ──────────────────────────────────────────────────────────
# 必须显式 SocketAttach：`jdb -attach host:port` 在 Windows 上会选 shmem 并失败。
$connect = "com.sun.jdi.SocketAttach:hostname=$HostName,port=$Port"
Write-Host "[i] 附加到 $connect" -ForegroundColor DarkGray
& $jdb -connect $connect
