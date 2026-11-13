@echo off
setlocal
for %%I in ("%~dp0..\..") do set "PROJECT_ROOT=%%~fI"
set "ELECTRON_EXE=%PROJECT_ROOT%\node_modules\electron\dist\electron.exe"
set "MANAGER_APP=%~dp0electron-app"
if not exist "%ELECTRON_EXE%" (
  echo Developer Electron 38.8.6 was not found. End users should run the packaged manager EXE.
  pause
  exit /b 1
)
if not defined DINO_MANAGER_PYTHON_EXE set "DINO_MANAGER_PYTHON_EXE=python"
"%ELECTRON_EXE%" "%MANAGER_APP%"
if errorlevel 1 pause
