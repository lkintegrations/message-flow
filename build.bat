@echo off
rem Thin wrapper so you can run this from cmd.exe without touching your
rem machine's PowerShell execution policy. All the real work is in build.ps1.
rem
rem Usage:
rem   build.bat "C:\Program Files\OpenIntegrationEngine\server-lib" "C:\path\to\websupport-1_0_3.zip"

if "%~2"=="" (
  echo Usage: build.bat "C:\path\to\server-lib" "C:\path\to\websupport-1_0_3.zip"
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" -ServerLib "%~1" -WebSupportSource "%~2"
exit /b %errorlevel%
