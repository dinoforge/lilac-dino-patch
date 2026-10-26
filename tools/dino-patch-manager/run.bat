@echo off
setlocal
cd /d "%~dp0..\.."

where python >nul 2>nul
if errorlevel 1 (
  echo Python 3 is required. No packages will be installed by this launcher.
  pause
  exit /b 1
)

python tools\dino-patch-manager\manager_gui.py
if errorlevel 1 pause
