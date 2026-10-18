@echo off
rem Deploy the latest main to THIS machine (ALCSERVER) and prove it is the code being served.
rem Run from an Administrator Command Prompt (restarting the service needs it):
rem   C:\_dev\tcg-listing-tools\scripts\deploy.cmd
rem   C:\_dev\tcg-listing-tools\scripts\deploy.cmd OtherServiceName
setlocal
cd /d "%~dp0.."
set "SERVICE=TCGListingTools"
if not "%~1"=="" set "SERVICE=%~1"

echo.
echo == Local changes on this machine ==
echo    Lines under data\ are this server's real settings (AGENTS.md golden rule 12). Leave them.
git status --porcelain
echo.

for /f %%h in ('git rev-parse HEAD') do set "BEFORE=%%h"
git pull --ff-only origin main
if errorlevel 1 (
  echo.
  echo PULL FAILED. Nothing was changed and the service was not touched. Read git's message above.
  exit /b 1
)
for /f %%h in ('git rev-parse HEAD') do set "AFTER=%%h"
if "%BEFORE%"=="%AFTER%" (
  echo Already up to date at %AFTER%. Restarting anyway so the running code matches the disk.
)

git diff --quiet %BEFORE% %AFTER% -- package.json pnpm-lock.yaml
if errorlevel 1 (
  echo Dependencies changed: pnpm install --frozen-lockfile
  call pnpm install --frozen-lockfile
  if errorlevel 1 ( echo pnpm install FAILED. The service was not restarted. & exit /b 1 )
)

echo.
echo == Restarting %SERVICE% ==
net stop "%SERVICE%"
net start "%SERVICE%"
if errorlevel 1 (
  echo Could not start %SERVICE%. Is this an Administrator prompt, and is that the service name?
  exit /b 1
)

node "%~dp0deploy-check.mjs" %AFTER%
exit /b %ERRORLEVEL%
