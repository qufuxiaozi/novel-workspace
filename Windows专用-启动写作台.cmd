@echo off
cd /d "%~dp0"
set "NODE_BIN=node.exe"
where node.exe >nul 2>&1
if errorlevel 1 goto missing
"%NODE_BIN%" --version
"%NODE_BIN%" -e "if (+process.versions.node.split('.')[0] < 24 || !require('node:sqlite').DatabaseSync) process.exit(1)" >nul 2>&1
if not errorlevel 1 goto launch
echo The installed Node.js is incompatible. You can keep it or replace it with Node.js 24 or newer.
goto bundled
:missing
echo Node.js was not found on this computer.
:bundled
set "NODE_BIN=%~dp0runtime\node.exe"
if not exist "%NODE_BIN%" (
  echo Bundled Node.js is unavailable. Extract the entire portable ZIP, or install Node.js 24 or newer.
  pause
  exit /b 1
)
echo Using the Node.js 24 bundled with this app.
:launch
"%NODE_BIN%" app/launch.mjs
if errorlevel 1 pause
