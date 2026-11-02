$ErrorActionPreference = "Stop"

# llama.cpp project directory

$LlamaDir = "C:\llama.cpp"

# Qwen model

$Model = "Qwen/Qwen3-4B-GGUF:Q4_K_M"

# llama-server executable

$Server = Join-Path $LlamaDir "build\bin\Release\llama-server.exe"

# Verify llama-server exists

if (-not (Test-Path $Server)) {
Write-Host "ERROR: llama-server.exe not found at:" -ForegroundColor Red
Write-Host $Server
exit 1
}

Set-Location $LlamaDir

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "       Qwen Local LLM Server" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Model : $Model"
Write-Host "API   : http://127.0.0.1:8080"
Write-Host ""
Write-Host "Starting llama-server..."
Write-Host "Press Ctrl+C to stop the server."
Write-Host ""

& $Server -hf $Model
