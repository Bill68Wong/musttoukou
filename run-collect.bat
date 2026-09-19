@echo off
cd /d "%~dp0"
title MUST Dengxiao - Data Collector

rem ---- Locate Node.js ----
set "NODE_BIN="
where node >nul 2>nul && set "NODE_BIN=node"
if not defined NODE_BIN if exist "C:\Program Files\nodejs\node.exe" set "NODE_BIN=C:\Program Files\nodejs\node.exe"

if not defined NODE_BIN (
  echo.
  echo [ERROR] Node.js not found. Please install it from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

rem ---- Args: double-click = 30 min; custom e.g. run-collect.bat --minutes=10 ----
set "ARGS=%*"
if "%ARGS%"=="" set "ARGS=--minutes=30"

cls
echo ============================================================
echo    MUST Dengxiao - DSAT Data Collector
echo ------------------------------------------------------------
echo    Args    : %ARGS%
echo    Output  : data\tracking\
echo.
echo    - Takes about 30 minutes. Do NOT close this window.
echo    - Progress, success rate and latency are shown live below.
echo    - When finished, a [DONE] message appears; press any key to exit.
echo ============================================================
echo.

"%NODE_BIN%" scripts\track-collect.mjs %ARGS%
set "RC=%errorlevel%"

echo.
if "%RC%"=="0" (
  echo [DONE] Collection finished. Data saved to data\tracking\
) else (
  echo [WARN] Collector exit code = %RC% - network issue or stopped early.
  echo        See the latest -run.log under data\tracking\ for details.
)
echo.
pause
