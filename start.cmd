@echo off
cd /d "%~dp0"
title Qwen Slurp

:: Clean up stale nul file (created if run from Git Bash by accident)
if exist "%~dp0nul" del /f /q "%~dp0nul" 2>NUL

:: Ensure .logs directory exists
if not exist "%~dp0.logs" mkdir "%~dp0.logs"

echo.
echo ====================================
echo   Qwen Slurp - Qwen Web UI + API
echo ====================================
echo.

:: Kill existing process on port 3008
echo Checking for existing processes on port 3008...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3008 ^| findstr LISTENING') do (
    echo Killing process %%a...
    taskkill /F /PID %%a >NUL 2>&1
)

:: Install dependencies (none needed, but just in case)
echo Dependencies: none (zero-dep)
echo.

:: Start the server
echo Starting server on http://127.0.0.1:3008 ...
echo.
echo   Open http://127.0.0.1:3008/         for Qwen Web UI
echo   Open http://127.0.0.1:3008/demo     for simple chat demo
echo   Use http://127.0.0.1:3008/v1/       for OpenAI API
echo.
start "" "http://127.0.0.1:3008/"
timeout /t 2 >NUL
node src/server.js
timeout /t 5
