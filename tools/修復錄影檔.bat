@echo off
title 修復錄影檔（補上長度資訊）
set "FFMPEG=D:\Codex\doctor-video-pipeline-fast\node_modules\ffmpeg-static\ffmpeg.exe"

if not exist "%FFMPEG%" (
  echo   找不到 ffmpeg：%FFMPEG%
  pause
  exit /b 1
)

echo.
echo   用途：
echo     1. 播放器顯示不出影片長度、拖不動進度條
echo     2. 錄到一半當機，檔案播不完整
echo   這個工具會重建索引，不會重新壓縮，畫質不變、速度很快。
echo.
echo   請把 .webm 錄影檔「拖曳」到這個視窗裡，然後按 Enter：
set /p SRC=^> 
set SRC=%SRC:"=%

if not exist "%SRC%" (
  echo   找不到檔案：%SRC%
  pause
  exit /b 1
)

"%FFMPEG%" -y -err_detect ignore_err -i "%SRC%" -c copy "%SRC%.修復版.webm"

if errorlevel 1 (
  echo   修復失敗。
) else (
  echo   完成：%SRC%.修復版.webm
)
pause
