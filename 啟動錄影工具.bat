@echo off
title 會議錄影工具
cd /d "%~dp0"

set PORT=8787

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY (where py >nul 2>nul && set "PY=py")
if not defined PY (
  echo.
  echo   找不到 Python，無法啟動本機網頁伺服器。
  echo   請先安裝 Python 後再試一次。
  echo.
  pause
  exit /b 1
)

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "CHROME=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"

echo.
echo   正在啟動會議錄影工具...
echo.

start "meeting-rec-server" /min cmd /c "%PY% -m http.server %PORT% --bind 127.0.0.1"
timeout /t 2 /nobreak >nul

if defined CHROME (
  start "" "%CHROME%" "http://localhost:%PORT%/"
) else (
  echo   找不到 Chrome 或 Edge，改用預設瀏覽器開啟。
  echo   注意：這個工具需要 Chrome 或 Edge 才能正常運作。
  start "" "http://localhost:%PORT%/"
)

echo   ============================================================
echo.
echo     錄影工具已在瀏覽器開啟。
echo.
echo     錄影期間請「不要關掉這個黑色視窗」，
echo     也不要關掉那個瀏覽器分頁。
echo.
echo     全部做完、檔案也存好之後，
echo     在這個視窗按任意鍵就會關掉背景程式。
echo.
echo   ============================================================
echo.
pause >nul

taskkill /FI "WINDOWTITLE eq meeting-rec-server*" /T /F >nul 2>nul
exit /b 0
