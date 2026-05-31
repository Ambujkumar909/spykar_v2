@echo off
REM ============================================================
REM  Spykar Project - Stop / Shutdown
REM  Stops the backend API and frontend dashboard servers.
REM ============================================================

title Spykar Project Shutdown
setlocal

echo ============================================================
echo   Spykar Project - Shutting down...
echo ============================================================
echo.

set "STOPPED=0"

REM ---- Stop backend (port 4000) ----
echo [STOP] Stopping backend API (port 4000)...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":4000" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%P >nul 2>nul
    if not errorlevel 1 (
        echo        Killed process %%P
        set "STOPPED=1"
    )
)

REM ---- Stop frontend (port 3000) ----
echo [STOP] Stopping frontend dashboard (port 3000)...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%P >nul 2>nul
    if not errorlevel 1 (
        echo        Killed process %%P
        set "STOPPED=1"
    )
)

REM ---- Close the launcher terminal windows (best effort) ----
taskkill /F /FI "WINDOWTITLE eq Spykar Backend*" >nul 2>nul
taskkill /F /FI "WINDOWTITLE eq Spykar Frontend*" >nul 2>nul

echo.
if "%STOPPED%"=="1" (
    echo   Spykar servers stopped.
) else (
    echo   No running Spykar servers were found on ports 3000 / 4000.
)
echo ============================================================
echo.

endlocal
pause
exit /b 0
