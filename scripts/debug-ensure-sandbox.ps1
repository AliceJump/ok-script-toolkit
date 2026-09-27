#Requires -Version 5.1
<#
.SYNOPSIS
    确保「调试沙箱 IDE」在 JDWP 端口（默认 5005）上就绪：没起就自动拉起，起了就直接通过。

.DESCRIPTION
    **为什么需要它**：launch.json 里 `"type": "java"` 的附加配置**不会启动任何东西**
    （attach 是纯附加）—— 沙箱 IDE 没起、或 `gradlew runIde --debug-jvm` 还在编译
    没到监听那一步时按 F5，只会得到「Failed to attach to localhost:5005
    (attach timeout 30000)」。

    它作为「附加到沙箱 IDE」配置的 **preLaunchTask** 使用，把「起沙箱 → 等就绪 →
    附加」折成一次 F5：

    1. 端口已在监听（沙箱已在运行 / 上一次 F5 拉起的还在）→ 立即通过，
       **不会拉起第二个沙箱**；
    2. 否则在新命令行窗口里 detached 启动 `gradlew.bat runIde --debug-jvm`
       （日志在那个窗口里，`/k` 让窗口在 gradle 退出后保留）；
    3. 轮询端口直到 LISTENING 再结束 —— preLaunchTask 在任务**结束**后才放行
       附加，所以放行时端口必然就绪，不会再撞 attach timeout。

    ⚠️ 附加成功后沙箱 IDE 仍处于 `suspend=y` 挂起态，**按一次继续（F5 / Continue）**
    它才会启动出窗口（与 jdb 流程里「先输 cont」是同一回事）。

    ⚠️ 端口上若被无关进程占用，本脚本只看「在监听」就放行 —— 附加会打到那个进程上。
    真遇到先 `netstat -ano | findstr :5005` 查占用者。

.PARAMETER Port
    调试端口，默认 5005（与 `gradlew runIde --debug-jvm` 的默认端口一致）。

.PARAMETER TimeoutMinutes
    等待端口监听的超时（分钟），默认 10 —— 首次要下载/解压 IDE SDK 时留足余量。

.EXAMPLE
    powershell -NoProfile -File scripts/debug-ensure-sandbox.ps1
.EXAMPLE
    powershell -NoProfile -File scripts/debug-ensure-sandbox.ps1 -Port 5006
#>
[CmdletBinding()]
param(
    [int]$Port = 5005,
    [int]$TimeoutMinutes = 10
)

function Test-PortListening {
    param([int]$Port)
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return $null -ne $listener
}

if (Test-PortListening $Port) {
    Write-Host "端口 $Port 已在监听 —— 沙箱 IDE 已就绪，直接附加（附加后记得按一次继续）。"
    exit 0
}

$jetbrainsDir = (Resolve-Path (Join-Path $PSScriptRoot "..\jetbrains")).Path
Write-Host "端口 $Port 未监听 —— 在新窗口启动 gradlew runIde --debug-jvm（gradle 日志见弹出的窗口）..."
Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/k", "gradlew.bat runIde --debug-jvm --console=plain" `
    -WorkingDirectory $jetbrainsDir | Out-Null

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
while ((Get-Date) -lt $deadline) {
    if (Test-PortListening $Port) {
        Write-Host "端口 $Port 已监听（suspend=y 等待附加）—— 任务结束，VS Code 将自动附加；附加后按一次继续（F5）启动 IDE。"
        exit 0
    }
    Start-Sleep -Seconds 2
}
Write-Error "等待端口 $Port 监听超时（$TimeoutMinutes 分钟）—— 请查看新弹出的 gradle 窗口里的报错。"
exit 1
