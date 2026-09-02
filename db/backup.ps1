# MUST登校 · 每日备份脚本（db/backup.ps1）
# 从 Supabase 云库导出完整备份到本地 backups/ 目录，保留最近 30 份
# 手动运行：npm run db:backup
# 自动运行：Windows 任务计划每日 09:00（首次需手动注册，见 docs/spec.md 第 8 节）

$ErrorActionPreference = "Stop"

# 加载 .env 中的 DATABASE_URL
$envFile = Join-Path $PSScriptRoot "..\.env"
if (-Not (Test-Path $envFile)) {
    Write-Host "[backup] 未找到 .env，无法获取云库连接串" -ForegroundColor Red
    exit 1
}
$connStr = (Get-Content $envFile | Select-String "^DATABASE_URL=(.+)$").Matches[0].Groups[1].Value
if (-Not $connStr) {
    Write-Host "[backup] .env 中没有 DATABASE_URL" -ForegroundColor Red
    exit 1
}

$backupDir = Join-Path $PSScriptRoot "..\backups"
if (-Not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }

$date = Get-Date -Format "yyyy-MM-dd"
$outFile = Join-Path $backupDir "$date.dump"

Write-Host "[backup] 开始备份 Supabase -> $outFile"
& pg_dump --no-owner --no-privileges --format=custom --dbname=$connStr --file=$outFile

if ($LASTEXITCODE -ne 0) {
    Write-Host "[backup] pg_dump 失败（退出码 $LASTEXITCODE）。请确认 pg_dump 已安装且版本 >= 云库版本" -ForegroundColor Red
    exit 1
}

$size = [math]::Round((Get-Item $outFile).Length / 1KB, 1)
Write-Host "[backup] 完成：$outFile（${size} KB）" -ForegroundColor Green

# 清理 30 天前的旧备份
Get-ChildItem $backupDir -Filter "*.dump" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
    Remove-Item -Confirm:$false
Write-Host "[backup] 旧备份清理完成（保留 30 天）"
