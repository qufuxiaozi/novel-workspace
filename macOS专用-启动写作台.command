#!/bin/sh
cd "$(dirname "$0")" || exit 1
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
export PATH
if command -v node >/dev/null 2>&1; then
  node --version
  if node -e "if (+process.versions.node.split('.')[0] < 24 || !require('node:sqlite').DatabaseSync) process.exit(1)" >/dev/null 2>&1; then
    exec node app/launch.mjs
  fi
  printf '%s\n' '系统 Node.js 与本项目不兼容。你可以保留它，也可以自行更换为 Node.js 24 或更新版本。'
else
  printf '%s\n' '未检测到系统 Node.js。'
fi
if [ ! -x runtime/bin/node ]; then
  printf '%s\n' '找不到可运行的随包 Node.js。请完整解压便携包，或安装 Node.js 24 或更新版本。'
  exit 1
fi
printf '%s\n' '正在使用随包附带的 Node.js 24。'
exec ./runtime/bin/node app/launch.mjs
