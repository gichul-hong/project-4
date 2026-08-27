@echo off
setlocal
set "COLLECTOR_PYTHON=%~dp0..\..\.venv\Scripts\python.exe"
if exist "%COLLECTOR_PYTHON%" goto run
set "COLLECTOR_PYTHON=python"
:run
"%COLLECTOR_PYTHON%" "%~dp0collector_app.py"
endlocal
