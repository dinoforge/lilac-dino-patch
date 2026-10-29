@echo off
setlocal
cd /d "%~dp0..\.."

where python >nul 2>nul
if errorlevel 1 (
  echo Python is required only for developer source mode. End users should run the packaged DinoPatchManager EXE.
  pause
  exit /b 1
)

python tools\dino-patch-manager\manager_gui.py
if errorlevel 1 pause
