@echo off
rem Double-click to finish the Thursday loose ends (see finish-thursday.ps1 for what it does).
cd /d "%~dp0.."
echo.
echo Optional: paste your EMPTY GitHub repository URL to push at the end,
echo e.g. https://github.com/you/ai-e2e-agent.git  (press Enter to skip pushing)
set /p REMOTE=GitHub URL: 
if "%REMOTE%"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0finish-thursday.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0finish-thursday.ps1" -Remote "%REMOTE%"
)
echo.
pause
