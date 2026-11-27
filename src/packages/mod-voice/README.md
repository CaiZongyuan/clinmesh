# 工作台语音

Hospital Data Pack 的 `manifest.enabledModules` 包含 `mod-voice` 时，负责医生可在进行中的问诊使用语音。宿主设置 `CLINMESH_VOICE_ENABLED=0` 可统一关闭语音入口。文字问诊和助手照常使用。

- 在「语音设置」选择百炼，使用自托管环境变量 `BAILIAN_TOKEN`，也可在本浏览器填写语音密钥。浏览器密钥优先，仅存本机 `localStorage`，在同源 WSS 的 `Sec-WebSocket-Protocol` 请求头中发送。宿主只回送固定协议名 `clinmesh.voice.v1`。开发机回环地址支持明文调试。Node 读取进程环境，Wrangler 本地读取 `.dev.vars`。
- 无密钥时可显式选择 **Browser Web Speech**。识别和播报取决于浏览器、操作系统与语言支持，有的浏览器会将音频交给其语音服务。浏览器和百炼的识别失败均会在界面提示。
- 开启诊室主麦后，中间字幕仅预览。每句终态会依次送交 Patient Agent，带有医生归属和 `voice` 通道。可开启「播报患者回复」，再次说话或点击「打断患者播报」可停止合成和播放。Ambient Mode 启用后沿用医生助手的终态问诊观察。
- 在医生助手面板按住按钮或空格键录音，松开后可核对私有指令，再点击「发送给助手」。助手录音会静音诊室主麦，切回问诊时可手动开启。离开就诊、切换岗位或更换引擎会结束当前采集。

两个宿主的 `/api/voice/session` 使用 `agents/voice` v1 输入型通话协议。负责医生通过访客门禁后携带当前 `epoch` 和 `encounterId` 建连。`start_call` 开始接收二进制 PCM，`transcript_interim` 和 `transcript` 分别返回中间和终态文本，`end_call` 排空采集后返回 `idle`。前端自按下开始采集，在连接就绪前最多暂存十秒音频。`Transcriber.createSession()` 接受 16 kHz 单声道小端 PCM。`TTSProvider.synthesize()` 接受音色与 `AbortSignal`。两个宿主向固定百炼端点发送带 Bearer 头的请求。
