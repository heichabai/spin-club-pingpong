# Render 部署

这一版本保留手机 3D 球台与手势物理，并将房间服务改为普通 Node.js 服务。

- 构建：`npm ci && npm run build:render`
- 启动：`npm run start:render`
- 运行环境：Node 24.21.0，监听 `0.0.0.0:$PORT`
- 推荐：新加坡区域，Free 方案，健康检查 `/healthz`
- 房间为临时会话，服务休眠、重启或重新部署后需重新建房。
- 只部署一个实例；联机优先 WebRTC，不通时沿用同源 HTTP 中继。
- Free 服务闲置可能休眠，首次访问需等待唤醒；正式比赛的延迟与手机可达性仍需实机验证。

将源码上传至 GitHub 的新仓库，再把仓库链接发回对话，即可继续创建 Render 服务。不要上传 node_modules、.env、.git、.wrangler 或 .openai 本地信息。

## 验证

`node --test tests/physics.test.mjs tests/game-integration.test.mjs`

`node render/test-api.mjs`

手势输入记录未裁剪的手指轨迹，实际球拍位置限制在可达区；用最近 45ms 的轨迹估计击球速度和加速度。自动高度变化不会改变触摸投影平面。上划、下划、横擦通过接触摩擦产生真实角速度，飞行和台面反弹均使用该角速度。

这是独立实现；原作内部参数未公开，不能宣称与《虚拟乒乓球》完全相同。
