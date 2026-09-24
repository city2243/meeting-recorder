@echo off
title 把錄影檔轉成 MP4
set "FFMPEG=D:\Codex\doctor-video-pipeline-fast\node_modules\ffmpeg-static\ffmpeg.exe"

if not exist "%FFMPEG%" (
  echo.
  echo   找不到 ffmpeg：%FFMPEG%
  echo   請把這個檔案裡的 FFMPEG 路徑改成這台電腦上 ffmpeg.exe 的位置。
  echo.
  pause
  exit /b 1
)

set "SRC=%~1"
if "%SRC%"=="" (
  echo.
  echo   請把要轉檔的 .webm 錄影檔「拖曳」到這個視窗裡，然後按 Enter：
  set /p SRC=^> 
)
set SRC=%SRC:"=%

if not exist "%SRC%" (
  echo   找不到檔案：%SRC%
  pause
  exit /b 1
)

echo.
echo   轉檔中，一小時的影片大約要幾分鐘到十幾分鐘，請耐心等...
echo.
"%FFMPEG%" -y -i "%SRC%" -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p -c:a aac -b:a 160k "%SRC%.mp4"

if errorlevel 1 (
  echo.
  echo   轉檔失敗。
) else (
  echo.
  echo   完成：%SRC%.mp4
)
pause
