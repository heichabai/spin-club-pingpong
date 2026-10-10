# Render 部署

这一版本保留手机 3D 球台与手势物理，并将房间服务改为普通 Node.js 服务。

- 构建：`npm ci && npm run build:render`
- 启动：`npm run start:render`
- 运行环境：Node 24.21.0，监听 `0.0.0.0:$PORT`
- 推荐：新加坡区域，Free 方案，健康检查 `/healthz`
- 房间为临时会话，服务休眠、重启或重新部署后需重新建房。
- 只部署一个实例；联机优先 WebRTC，不通时使用同源 WebSocket 实时中继；HTTP 保留用于房间管理及断线恢复。
- Free 服务闲置可能休眠，首次访问需等待唤醒；正式比赛的延迟与手机可达性仍需实机验证。

当前服务使用公开仓库 URL，主分支更新后需手动触发 Render 部署；连接 GitHub 集成后可启用自动部署。不要上传 node_modules、.env、.git、.wrangler 或 .openai 本地信息。

## 验证

`node --test tests/physics.test.mjs tests/game-integration.test.mjs`

`node render/test-api.mjs`

启动服务后运行 `node render/test-live.mjs`，验证实时双向传输、可靠命令确认、断线重连和凭据撤销。

手势输入记录未裁剪的手指轨迹，实际球拍位置限制在可达区；用最近 45ms 的轨迹估计击球速度和加速度。自动高度变化不会改变触摸投影平面。上划、下划、横擦通过接触摩擦产生真实角速度，飞行和台面反弹均使用该角速度。

这是独立实现；原作内部参数未公开，不能宣称与《虚拟乒乓球》完全相同。
