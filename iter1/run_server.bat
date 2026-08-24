@echo off
chcp 65001 > nul
setlocal

echo ========================================================
echo   🏺 고대 이집트 피라미드 AR 호스트 서버 실행 (HTTPS 모드)
echo ========================================================
echo.

:: pjt-4 파이썬 경로 탐색
set "PYTHON_EXE=C:\Users\%USERNAME%\.conda\envs\pjt-4\python.exe"
if not exist "%PYTHON_EXE%" (
    set "PYTHON_EXE=python"
)

echo [1] Host 3D 뷰어 주소 (대형 스크린): https://localhost:8000
echo [2] 다른 랩탑 웹캠 클라이언트 접속 주소 (브라우저 접속):
echo     - User 1 (Red)   : https://147.47.201.63:8000/client?id=client_1
echo     - User 2 (Cyan)  : https://147.47.201.63:8000/client?id=client_2
echo     - User 3 (Gold)  : https://147.47.201.63:8000/client?id=client_3
echo     - User 4 (Green) : https://147.47.201.63:8000/client?id=client_4
echo.
echo 💡 [안내] 브라우저 첫 접속 시 '고급' -> '안전하지 않음으로 이동'을 클릭하세요.
echo.
echo 서버를 시작합니다... (종료: Ctrl+C)
echo.

"%PYTHON_EXE%" iter1\run_server.py
pause
