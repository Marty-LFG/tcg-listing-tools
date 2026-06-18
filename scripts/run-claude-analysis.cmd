@echo off
REM run-claude-analysis.cmd — daily headless price analysis via the Claude CLI.
REM Wire this into Windows Task Scheduler ("Run only when user is logged on" so toasts
REM render). The Claude CLI must be pre-authenticated for the logged-on user.
REM Requires the TCG Listing Tools service (Vite, port 5273) to be running.

setlocal
set ROOT=%~dp0..
cd /d "%ROOT%"

if not exist "logs" mkdir "logs"
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set DT=%%I
set LOG=logs\claude-analysis-%DT:~0,8%.log

echo [%DATE% %TIME%] starting price-analyst >> "%LOG%"

REM --print runs headless; the prompt invokes the project skill. Adjust the permission
REM flag to taste: --permission-mode acceptEdits limits writes to approved edits; if your
REM unattended setup needs no prompts at all, use --dangerously-skip-permissions instead.
claude --print "Run the price-analyst skill for today's date and act on its steps." ^
  --allowedTools "Bash" "WebSearch" "WebFetch" "Read" "Write" ^
  --permission-mode acceptEdits >> "%LOG%" 2>&1

echo [%DATE% %TIME%] finished (exit %ERRORLEVEL%) >> "%LOG%"
endlocal
