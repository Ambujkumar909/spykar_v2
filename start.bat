@echo off
REM ============================================================
REM  Spykar Project - One-Click Startup
REM  Starts the backend API and the frontend dashboard.
REM
REM  PostgreSQL is expected to be reachable via the settings in
REM  spykar-backend\.env (a remote / managed database). Redis is
REM  OPTIONAL - if it isn't running the API still starts and serves
REM  directly from PostgreSQL (no Docker required).
REM ============================================================

title Spykar Project Launcher
setlocal

set "ROOT=%~dp0"
set "BACKEND=%ROOT%spykar-backend"
set "FRONTEND=%ROOT%spykar-frontend"

echo ============================================================
echo   Spykar Project - Starting up...
echo ============================================================
echo.

REM ---- Check Node.js is installed ----
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found on PATH.
    echo         Please install Node.js 18+ from https://nodejs.org
    echo.
    pause
    exit /b 1
)

REM ---- Check backend .env exists (holds the database connection) ----
if not exist "%BACKEND%\.env" (
    echo [WARN] %BACKEND%\.env not found.
    echo        The backend needs PG_HOST / PG_PORT / PG_DATABASE / PG_USER /
    echo        PG_PASSWORD set there to reach the database. Copy .env.example
    echo        to .env and fill it in. Continuing anyway...
    echo.
)

REM ---- Install backend dependencies if missing ----
if not exist "%BACKEND%\node_modules" (
    echo [SETUP] Installing backend dependencies...
    pushd "%BACKEND%"
    call npm install
    popd
)

REM ---- Install frontend dependencies if missing ----
if not exist "%FRONTEND%\node_modules" (
    echo [SETUP] Installing frontend dependencies...
    pushd "%FRONTEND%"
    call npm install
    popd
)

REM ---- Launch backend in its own window ----
echo [START] Launching backend API (http://localhost:4000)...
start "Spykar Backend" cmd /k "cd /d "%BACKEND%" && npm run dev"

REM ---- Launch frontend in its own window ----
echo [START] Launching frontend dashboard (http://localhost:3000)...
start "Spykar Frontend" cmd /k "cd /d "%FRONTEND%" && npm run dev"

REM ---- Give servers a moment, then open the dashboard ----
timeout /t 6 /nobreak >nul
start "" "http://localhost:3000"

echo.
echo ============================================================
echo   Spykar is starting!
echo   Backend  -^> http://localhost:4000
echo   Frontend -^> http://localhost:3000
echo.
echo   Two terminal windows have opened (backend + frontend).
echo   Close those windows to stop the servers.
echo ============================================================
echo.

endlocal
exit /b 0
