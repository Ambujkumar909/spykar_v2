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

REM ============================================================
REM  PRODUCTION MODE
REM  The frontend is built once (optimized + minified) and served via
REM  `next start` instead of `next dev`. This removes Next.js's on-demand
REM  per-page compilation and ships minified bundles, so the dashboard
REM  loads 3-10x faster. The backend runs with plain `npm start` (node,
REM  no nodemon) for a stable production server.
REM ============================================================

REM ---- Build the frontend for production (runs in THIS window so you see
REM      progress; servers launch only after a successful build) ----
echo [BUILD] Building frontend for production (~30-60s)...
pushd "%FRONTEND%"
call npm run build
if errorlevel 1 (
    echo.
    echo [ERROR] Frontend production build FAILED. Fix the error above, then
    echo         run start.bat again. Servers were NOT launched.
    popd
    pause
    exit /b 1
)
popd

REM ---- Launch backend in its own window (production: node, no nodemon) ----
echo [START] Launching backend API (http://localhost:4000)...
start "Spykar Backend" cmd /k "cd /d "%BACKEND%" && npm start"

REM ---- Launch frontend in its own window (production: next start) ----
echo [START] Launching frontend dashboard (http://localhost:3000)...
start "Spykar Frontend" cmd /k "cd /d "%FRONTEND%" && npm start"

REM ---- Give the production servers a moment to boot, then open the dashboard ----
timeout /t 8 /nobreak >nul
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
