# 小说工作台

单人使用的浏览器写作工作台，支持本机写作、参考小说、素材库、AI 改写和竞品拆书。运行环境为 Node.js 24 或更新版本。启动命令在项目目录执行。

```sh
node app/server.mjs
```

打开 http://127.0.0.1:4312/。应用默认监听本机地址，首次启动创建 `data/novels.sqlite`。可通过 `NOVEL_DATABASE` 指定独立的数据文件，`NOVEL_PORT` 可调整监听端口。

## Windows 和 macOS

先按操作系统和处理器选择便携包，然后完整解压。Windows 双击 `Windows专用-启动写作台.cmd`，macOS 双击 `macOS专用-启动写作台.command`。脚本优先使用已安装且支持本项目的 Node.js 24 或更新版本。系统版本缺失或不兼容时，便携包自动使用随包的 Node.js 24，系统安装由用户自行管理。若使用源码包，请先安装兼容版本。

脚本会启动本机服务，等页面可访问后自动打开默认浏览器。使用期间保持启动窗口打开。

如果 macOS 提示文件不可执行，在解压目录运行 `chmod +x "macOS专用-启动写作台.command"`，再双击。也可在终端运行 `sh "macOS专用-启动写作台.command"`。如果需要手动启动，在解压目录运行 `node app/server.mjs`，然后访问上面的本机地址。

Windows 可在「设置 → AI 模型」加密保存 API Key，使用当前 Windows 用户的 DPAPI。请在安装后填入自己的 Key。macOS 和 Linux 的云端 Key 由启动进程的环境变量提供。本机 Ollama 无需 Key。

## Linux 服务器

使用专用系统账号启动应用，设置该账号可读写的 `NOVEL_DATABASE`，可用 systemd 或宝塔进程管理保持运行。保持默认回环监听，通过 SSH 转发访问个人实例。

```sh
ssh -N -L 4312:127.0.0.1:4312 username@your-server
```

保持转发连接，再从自己的设备打开 http://127.0.0.1:4312/。应用采用单人模式，服务端没有多用户登录与权限隔离。

## AI 模型配置

设置页提供火山方舟 Agent Plan、火山方舟平台 API、DeepSeek、阿里云百炼、智谱 GLM、Kimi、OpenAI API、本机 Ollama 和自定义 Chat Completions 兼容接口。填写服务商允许调用的模型 ID 和该接口对应的 Key。百炼支持填写与 Key 同地域的工作空间地址。

macOS 或 Linux 的服务环境提供 `NOVEL_AI_BASE_URL`、`NOVEL_AI_MODEL` 和 `NOVEL_AI_API_KEY`。请使用系统服务的私有环境配置，权限仅授予运行账号。网页订阅是否支持 API 调用由各服务商的套餐规则决定。

## 示例与发布

用 `examples/雾港来信.txt` 测试参考小说导入、卷章定位和竞品拆书。示例为原创演示文本。

公开发布按文件清单打包。发布包只包含应用源码、本说明、忽略规则和原创示例。SQLite 数据、加密 Key、环境文件、私人稿件、导入小说、分析结果及素材库均留在使用者设备。

新增 Windows x64、macOS Apple 芯片和 macOS Intel 便携包，内置 Node.js 24.22.3。下载对应 ZIP，完整解压后双击专用启动文件。脚本会优先使用电脑上已安装的兼容版本，必要时切换到内置版本，并自动打开浏览器。使用期间请保持启动窗口开启。基础写作无需 API Key。

