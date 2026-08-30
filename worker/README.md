# 匿名排行榜后端

该目录包含“魔精大融合”排行榜所需的 Cloudflare Worker 与 D1 数据库。玩家不需要登录；浏览器首次运行时会生成随机安装 ID 和本地密钥。服务器公开的只有匿名短码。

## 部署

1. 安装 Node.js，然后在本目录执行 `npm install`。
2. 执行 `npx wrangler login`，登录你的 Cloudflare 账号。
3. 创建数据库：`npx wrangler d1 create critters-leaderboard`。
4. 将命令返回的数据库 ID 填入 `wrangler.toml` 的 `database_id`。
5. 将 `ALLOWED_ORIGINS` 改成实际 GitHub Pages 来源，例如 `https://example.github.io`。不要填写页面路径，也不要保留末尾斜杠。
6. 初始化远程数据库：`npm run db:migrate`。
7. 部署接口：`npm run deploy`。
8. 将部署得到的 HTTPS 地址填入项目根目录 `leaderboard-config.js` 的 `leaderboardApi`。

### 已有数据库升级昵称功能

如果数据库已经初始化过，部署新版 Worker 前只执行一次：

`npx wrangler d1 execute critters-leaderboard --remote --file=./migrations/0002_display_name.sql`

全新数据库直接执行 `npm run db:migrate` 即可，不需要再运行上面的升级命令。

部署后，访问 `https://你的接口地址/health` 应返回 `{"ok":true,...}`。排行榜页面会自动注册当前浏览器的匿名身份，并同步此前离线保存的最高成绩。

## 本地开发

执行 `npm run db:migrate:local` 初始化本地数据库，再执行 `npm run dev`。建议通过本地 HTTP 服务器打开游戏，并将其来源加入 `ALLOWED_ORIGINS`；不要依赖 `file://` 页面测试跨域接口。

## 基础防护

- 每个安装身份持有仅保存在本机的随机密钥，不能修改其他身份的成绩。
- 每个身份、每种模式仅保留一个最高分，低分不会覆盖高分。
- 玩家可以设置 2–12 字的排行榜昵称；匿名设备短码仍作为不可变身份保留，昵称每 24 小时最多修改一次。
- Worker 校验模式、整数分数、投放次数、游戏时长和宽松的分数上限。
- Rate Limiting binding 默认限制每个身份每分钟 12 次注册或提交请求。
- POST 接口只允许 `ALLOWED_ORIGINS` 中的网站调用。

这是适合休闲游戏的基础保护。游戏物理和计分仍运行在客户端，因此无法抵御刻意修改客户端或伪造整局数据的攻击。
