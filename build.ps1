param (
    [string]$Action = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location -LiteralPath $PSScriptRoot
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"

function Show-Header {
    Clear-Host
    Write-Host "=======================================================" -ForegroundColor Cyan
    Write-Host "        MCP Terminal - Сборка проекта          " -ForegroundColor Cyan
    Write-Host "=======================================================" -ForegroundColor Cyan
    Write-Host ""
}

function Ensure-Dependencies {
    $modulesPath = Join-Path $PSScriptRoot "node_modules"
    if (-not (Test-Path -LiteralPath $modulesPath)) {
        Write-Host "`n[Инфо] node_modules не найден. Установка зависимостей (npm install)..." -ForegroundColor Yellow
        & cmd.exe /c "npm install"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "`n[ОШИБКА] Ошибка при выполнении npm install!" -ForegroundColor Red
            return $false
        }
    }
    $electronDist = Join-Path $PSScriptRoot "node_modules\electron\dist"
    if (-not (Test-Path -LiteralPath $electronDist)) {
        Write-Host "`n[Инфо] Загрузка бинарных файлов Electron..." -ForegroundColor Yellow
        & node (Join-Path $PSScriptRoot "node_modules\electron\install.js")
        if ($LASTEXITCODE -ne 0) {
            Write-Host "`n[ОШИБКА] Ошибка при установке бинарных файлов Electron!" -ForegroundColor Red
            return $false
        }
    }
    return $true
}

function Build-Project {
    $script:BuildOk = $false
    if (-not (Ensure-Dependencies)) {
        return
    }

    Write-Host "`n[1/2] Компиляция проекта (TypeScript + Vite)..." -ForegroundColor Yellow
    & cmd.exe /c "npm run build"
    if ($LASTEXITCODE -eq 0) {
        $script:BuildOk = $true
    } else {
        Write-Host "`n[ОШИБКА] Компиляция TypeScript/Vite завершилась с ошибкой!" -ForegroundColor Red
    }
}

function Do-Portable {
    Build-Project
    if (-not $script:BuildOk) { return }
    Write-Host "`n[2/2] Упаковка в Portable.exe..." -ForegroundColor Yellow
    npx electron-builder --win portable
    if ($LASTEXITCODE -eq 0) {
        Write-Host "`n=======================================================" -ForegroundColor Green
        Write-Host " [УСПЕХ] Файл готов: release\MCP Terminal Portable.exe" -ForegroundColor Green
        Write-Host "=======================================================" -ForegroundColor Green
    } else {
        Write-Host "`n[ОШИБКА] Упаковка Portable завершилась с ошибкой!" -ForegroundColor Red
    }
}

function Do-Installer {
    Build-Project
    if (-not $script:BuildOk) { return }
    Write-Host "`n[2/2] Создание инсталлятора (Setup.exe)..." -ForegroundColor Yellow
    npx electron-builder --win nsis
    if ($LASTEXITCODE -eq 0) {
        Write-Host "`n=======================================================" -ForegroundColor Green
        Write-Host " [УСПЕХ] Установщик готов в папке release\" -ForegroundColor Green
        Write-Host "=======================================================" -ForegroundColor Green
    } else {
        Write-Host "`n[ОШИБКА] Создание инсталлятора завершилось с ошибкой!" -ForegroundColor Red
    }
}

function Do-All {
    Build-Project
    if (-not $script:BuildOk) { return }
    Write-Host "`n[2/2] Упаковка всех вариантов (Portable + Setup)..." -ForegroundColor Yellow
    npx electron-builder --win
    if ($LASTEXITCODE -eq 0) {
        Write-Host "`n=======================================================" -ForegroundColor Green
        Write-Host " [УСПЕХ] Все файлы собраны в папке release\" -ForegroundColor Green
        Write-Host "=======================================================" -ForegroundColor Green
    } else {
        Write-Host "`n[ОШИБКА] Упаковка завершилась с ошибкой!" -ForegroundColor Red
    }
}

function Do-Dir {
    Build-Project
    if (-not $script:BuildOk) { return }
    Write-Host "`n[2/2] Распаковка приложения в папку release\win-unpacked..." -ForegroundColor Yellow
    npx electron-builder --win --dir
    if ($LASTEXITCODE -eq 0) {
        Write-Host "`n=======================================================" -ForegroundColor Green
        Write-Host " [УСПЕХ] Распакованная версия готова: release\win-unpacked\" -ForegroundColor Green
        Write-Host "=======================================================" -ForegroundColor Green
    } else {
        Write-Host "`n[ОШИБКА] Распаковка завершилась с ошибкой!" -ForegroundColor Red
    }
}

function Do-Clean {
    Write-Host "`nОчистка папки release..." -ForegroundColor Yellow
    $relPath = Join-Path $PSScriptRoot "release"
    if (Test-Path -LiteralPath $relPath) {
        Remove-Item -LiteralPath $relPath -Recurse -Force
        Write-Host "[OK] Папка release успешно удалена." -ForegroundColor Green
    } else {
        Write-Host "Папка release уже пуста или не существует." -ForegroundColor Gray
    }
}

# Если передан аргумент командной строки
switch ($Action.ToLower()) {
    "portable"  { Do-Portable;  Read-Host "`nНажмите Enter для выхода"; exit }
    "installer" { Do-Installer; Read-Host "`nНажмите Enter для выхода"; exit }
    "all"       { Do-All;       Read-Host "`nНажмите Enter для выхода"; exit }
    "dir"       { Do-Dir;       Read-Host "`nНажмите Enter для выхода"; exit }
    "clean"     { Do-Clean;     Read-Host "`nНажмите Enter для выхода"; exit }
}

# Интерактивное меню
while ($true) {
    Show-Header
    Write-Host " [1] Собрать Portable версию (Portable.exe)" -ForegroundColor White
    Write-Host " [2] Собрать Установщик (Setup.exe)" -ForegroundColor White
    Write-Host " [3] Собрать Всё (Portable + Setup)" -ForegroundColor White
    Write-Host " [4] Быстрая распаковка в release\win-unpacked" -ForegroundColor White
    Write-Host " [5] Очистить папку release" -ForegroundColor White
    Write-Host ""
    Write-Host " [0] Выход" -ForegroundColor Gray
    Write-Host "=======================================================" -ForegroundColor Cyan

    $choice = Read-Host "Выберите действие (0-5)"
    switch ($choice) {
        "1" { Do-Portable;  Read-Host "`nНажмите Enter для продолжения" }
        "2" { Do-Installer; Read-Host "`nНажмите Enter для продолжения" }
        "3" { Do-All;       Read-Host "`nНажмите Enter для продолжения" }
        "4" { Do-Dir;       Read-Host "`nНажмите Enter для продолжения" }
        "5" { Do-Clean;     Read-Host "`nНажмите Enter для продолжения" }
        "0" { exit }
        default {
            Write-Host "Неверный выбор. Повторите попытку..." -ForegroundColor Red
            Start-Sleep -Seconds 1
        }
    }
}
