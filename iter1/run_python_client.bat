@echo off
chcp 65001 > nul
setlocal

echo ========================================================
echo   🖐️ Python AR 제스처 클라이언트 실행 (OpenCV + MediaPipe)
echo ========================================================
echo.

:: pjt-4 파이썬 경로 탐색
set "PYTHON_EXE=C:\Users\%USERNAME%\.conda\envs\pjt-4\python.exe"
if not exist "%PYTHON_EXE%" (
    set "PYTHON_EXE=python"
)

set /p CLIENT_ID="접속할 Client ID를 입력하세요 (기본값: client_1) [client_1 / client_2 / client_3 / client_4]: "
if "%CLIENT_ID%"=="" set CLIENT_ID=client_1

set /p HOST_IP="Host IP 주소를 입력하세요 (기본값: localhost): "
if "%HOST_IP%"=="" set HOST_IP=localhost

echo.
echo [*] ws://%HOST_IP%:8000/ws/%CLIENT_ID% 로 접속을 시작합니다...
"%PYTHON_EXE%" iter1\client_py\py_client.py --host ws://%HOST_IP%:8000/ws/%CLIENT_ID% --id %CLIENT_ID%
pause
