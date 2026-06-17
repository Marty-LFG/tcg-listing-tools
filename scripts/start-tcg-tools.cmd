@echo off
setlocal
cd /d "%~dp0.."

if not exist "vite.config.js" (
  echo ERROR: vite.config.js not found. Is the repo path correct?
  exit /b 1
)
if not exist "node_modules\vite\bin\vite.js" (
  echo ERROR: dependencies missing. Run: pnpm install
  exit /b 1
)

node "%~dp0run-dev.mjs"
exit /b %ERRORLEVEL%
