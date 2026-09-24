@echo off
title 合併分段錄影
set "FFMPEG=D:\Codex\doctor-video-pipeline-fast\node_modules\ffmpeg-static\ffmpeg.exe"

if not exist "%FFMPEG%" (
  echo   找不到 ffmpeg：%FFMPEG%
  pause
  exit /b 1
)

echo.
echo   用途：錄影中途重新接過畫面，產生了「第2段」「第3段」時，把它們接成一個檔。
echo.
echo   請把「存放錄影檔的資料夾」拖曳到這個視窗裡，然後按 Enter：
set /p DIR=^> 
set DIR=%DIR:"=%

if not exist "%DIR%" (
  echo   找不到資料夾：%DIR%
  pause
  exit /b 1
)

cd /d "%DIR%"
if exist __concat.txt del __concat.txt
for %%F in (會議錄影_*.webm) do (
  echo %%F | find "音訊備份" >nul || echo file '%%F'>>__concat.txt
)

if not exist __concat.txt (
  echo   這個資料夾裡沒有找到錄影檔。
  pause
  exit /b 1
)

echo.
echo   要合併的檔案：
type __concat.txt
echo.

"%FFMPEG%" -y -f concat -safe 0 -i __concat.txt -c copy "合併完成.webm"
del __concat.txt

if errorlevel 1 (echo   合併失敗。) else (echo   完成：%DIR%\合併完成.webm)
pause
