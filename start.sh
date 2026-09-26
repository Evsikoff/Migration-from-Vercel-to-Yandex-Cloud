#!/bin/sh
# Запуск на macOS / Linux.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Установите его с https://nodejs.org (версия 18 или новее)."
  exit 1
fi
exec node src/server.js "$@"
