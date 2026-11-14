@echo off
setlocal
title Yice Reader
cd /d "%~dp0"

set "PORT=5178"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"

echo Starting local server on port %PORT% ...
start "" /b node serve.mjs
timeout /t 2 /nobreak >nul

if exist "%EDGE%" (
  start "" "%EDGE%" --app=http://127.0.0.1:%PORT%/ --window-size=1440,900
) else if exist "%CHROME%" (
  start "" "%CHROME%" --app=http://127.0.0.1:%PORT%/ --window-size=1440,900
) else (
  start "" http://127.0.0.1:%PORT%/
)

echo.
echo Yice is running: http://127.0.0.1:%PORT%/
echo Keep this window open. Closing it stops the server.
echo.
pause >nul
