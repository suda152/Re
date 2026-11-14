@echo off
REM ---------------------------------------------------------------
REM Build the debug APK for "yice" (tablet app).
REM Toolchain lives outside the project, so this script pins it.
REM Override by setting JAVA_HOME / ANDROID_HOME before running.
REM ---------------------------------------------------------------
setlocal
cd /d "%~dp0"

if "%JAVA_HOME%"=="" set "JAVA_HOME=D:\Softwares\Android\jdk-17.0.21+9"
if "%ANDROID_HOME%"=="" set "ANDROID_HOME=D:\Softwares\Android\sdk"
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
set "PATH=%JAVA_HOME%\bin;%PATH%"

if not exist "%JAVA_HOME%\bin\javac.exe" (
  echo [ERR] JDK not found at "%JAVA_HOME%"
  echo       Install JDK 17 or set JAVA_HOME.
  exit /b 1
)
if not exist "%ANDROID_HOME%\platforms\android-34" (
  echo [ERR] Android SDK 34 not found at "%ANDROID_HOME%"
  exit /b 1
)
if not exist "local.properties" (
  echo sdk.dir=%ANDROID_HOME:\=\\%> local.properties
)

echo [1/2] Building web assets into www/ ...
pushd "%~dp0.."
call node tools/build-www.mjs
if errorlevel 1 (
  popd
  echo [ERR] build-www failed
  exit /b 1
)
REM Do NOT silence this: if cap sync fails the APK silently ships stale www/.
call npx cap sync android
if errorlevel 1 (
  popd
  echo [ERR] cap sync failed - assets would be stale, aborting.
  exit /b 1
)
popd

echo [2/2] Building APK ...
call gradlew.bat assembleDebug %*
if errorlevel 1 (
  echo.
  echo [ERR] BUILD FAILED
  exit /b 1
)

echo.
echo [OK] %~dp0app\build\outputs\apk\debug\app-debug.apk
endlocal
