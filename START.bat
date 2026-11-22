@echo off
setlocal EnableExtensions
chcp 65001 >nul
title 컨텐츠 저널링 도구
cd /d "%~dp0"

rem ---------------------------------------------------------------
rem  컨텐츠 저널링 도구 실행
rem  Node.js 가 PC에 없으면 이 폴더의 bin 에 자동으로 받아서 쓴다.
rem  (이 파일은 줄 끝이 CRLF 여야 한다. .gitattributes 참고)
rem ---------------------------------------------------------------

set "NODE="

rem 1) PC에 설치된 Node.js: 20 이상이면 그대로 쓴다
where node >nul 2>nul
if errorlevel 1 goto check_local
node -e "process.exit(+process.versions.node.split('.')[0]>=20?0:1)" >nul 2>nul
if errorlevel 1 goto check_local
set "NODE=node"
goto run

:check_local
rem 2) 이 폴더에 받아 둔 Node.js
if not exist "bin\node.exe" goto get_node
"bin\node.exe" --version >nul 2>nul
if errorlevel 1 goto get_node
set "NODE=%~dp0bin\node.exe"
goto run

:get_node
rem 3) 처음 실행: Node.js 실행 파일 하나를 받는다
echo.
echo   처음 실행 준비 중입니다.
echo   필요한 프로그램 Node.js 를 받습니다. 약 90MB 이고 인터넷 속도에 따라 1~3분 걸립니다.
echo   이 창을 닫지 말고 기다려 주세요.
echo.
if not exist "bin" mkdir "bin"
del /q "bin\node.exe.part" >nul 2>nul
set "NODE_URL=https://nodejs.org/dist/latest-v24.x/win-x64/node.exe"
where curl >nul 2>nul
if errorlevel 1 goto get_node_ps
curl.exe -L --fail --retry 2 --progress-bar -o "bin\node.exe.part" "%NODE_URL%"
goto got_node

:get_node_ps
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '%NODE_URL%' -OutFile 'bin\node.exe.part'"

:got_node
if errorlevel 1 goto fail_node
if not exist "bin\node.exe.part" goto fail_node
move /y "bin\node.exe.part" "bin\node.exe" >nul
"bin\node.exe" --version >nul 2>nul
if errorlevel 1 goto fail_node
set "NODE=%~dp0bin\node.exe"
echo.
echo   Node.js 준비 완료
goto run

:fail_node
del /q "bin\node.exe.part" >nul 2>nul
del /q "bin\node.exe" >nul 2>nul
echo.
echo   [오류] Node.js 를 받지 못했습니다.
echo   인터넷 연결을 확인한 뒤 이 창을 닫고 START 를 다시 실행해 주세요.
echo   계속 안 되면 https://nodejs.org 에서 Node.js 를 직접 설치한 뒤 다시 실행하면 됩니다.
echo.
pause
exit /b 1

:run
"%NODE%" server.js --open
if errorlevel 1 goto stopped
exit /b 0

:stopped
echo.
echo   프로그램이 멈췄습니다. 위에 나온 내용을 확인해 주세요.
echo.
pause
exit /b 1
