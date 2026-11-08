# RelayGo 部署指南

## 一、准备操作

在开始之前，请先准备：
1. 根据 [教程](https://wiki.tgnav.org/createrobot.html) 创建一个 Telegram 机器人，在 `Bot Settings` 中关闭 `Group Privacy`。
2. 创建一个群组（公开或私有都可以），开启 `Topics`（`话题模式`）。
3. 注册一个 [Cloudflare](https://www.cloudflare.com/zh-cn/) 账号。

## 二、创建 KV

前往 `Cloudflare Dashboard`->`Storage & databases`（`存储和数据库`）->`Workers KV`：

点击 `Create Instance`，KV 空间命名为 `relaygokv`。

## 三、创建 Worker

前往 `Cloudflare Dashboard` -> `Workers & Pages`，点击 `Create application`（`创建应用程序`），根据需求选择以下任一方式：

### 方式 1：GitHub Fork 自动部署（推荐，支持一键持续更新）

1. **Fork 本仓库**：点击页面右上角 **Fork** 按钮，将本仓库复刻到你的 GitHub 个人账号下。
2. **连接 GitHub**：
   * 在 Cloudflare 的 `Create application` 页面中，选择 **Import an existing repository**（导入现有代码库），点击 **GitHub**（若未授权请根据提示完成 GitHub 授权）。
   * 在仓库列表中选择你刚刚 Fork 的 `RelayGo` 仓库，点击 **Begin setup**（开始设置）。
3. **构建与部署设置**：
   * **Project name**（项目名称）：保持默认或填写 `relaygobot`。
   * **Production branch**（生产分支）：保持默认 `main`。
   * **Framework preset**（框架预设）：保持默认 **None**。
   * **Deploy command**（部署命令）：保持默认 `npx wrangler deploy`（仓库已自带 `wrangler.toml`，自动以 `worker.js` 为入口，无需修改）。
   * 点击 **Save and Deploy**（保存并部署），等待部署完成。

### 方式 2：网页在线编辑部署（零 Git 基础）

1. 在 Cloudflare 的 `Create application` 页面中，选择 **Start With Hello World**。
2. **Worker Name** 填写 `relaygobot`，点击 **Deploy**（`部署`）。
3. 部署完成后，点击右上角 **Edit Code**（`编辑代码`）。
4. 将代码编辑器中的内容全部清空，替换为本仓库 [worker.js](https://github.com/abcxyz-123456/RelayGo/blob/main/worker.js) 的完整代码。
5. 点击右上角 **Deploy**（`部署`）。

## 四、绑定 KV

进入 `Workers & Pages`->`relaygobot`->`Bindings`（`绑定`）：

点击 `Add binding`（`添加绑定`），弹出菜单中选择 `KV namespace`（`KV 命名空间`），变量名称填写 `KV` ，下方选择 `relaygokv`，完成绑定。

## 五、设置环境变量

进入 `Workers & Pages`->`relaygobot`->`Settings`（`设置`）。

下滑找到 `Variables and Secrets`（`变量和机密`），填入以下变量：

| 类型 | 变量名称 | 值 |
|:----:|:-------:|:---:|
| Secret | `BOT_TOKEN` | 你的机器人 token（可以在 [@BotFather](https://t.me/BotFather) 查看） |
| Secret | `OWNER_ID` | 你的 Telegram UID（可以通过 [@getidsbot](https://t.me/getidsbot) 获取） |
| Secret (可选) | `WEBHOOK_SECRET` | Webhook 鉴权密钥（可填写自定义强随机字符串，用于防伪造请求） |

## 六、设置 Telegram Webhook

打开浏览器访问（请替换链接中的`你的token`和`你的worker域名`字段）：

```
https://api.telegram.org/bot<你的token>/setWebhook?url=https://<你的worker域名>/webhook
```

> **提示（可选安全加固）**：若在第五步配置了 `WEBHOOK_SECRET`，请在 setWebhook 链接末尾附加 `&secret_token=<你的WEBHOOK_SECRET>`，例如：
> ```
> https://api.telegram.org/bot<你的token>/setWebhook?url=https://<你的worker域名>/webhook&secret_token=<你的WEBHOOK_SECRET>
> ```

示例：

```
https://api.telegram.org/bot123456:ABCDEFG/setWebhook?url=https://relaygobot.example.workers.dev/webhook
```

发送 `/start` 给你的机器人，确认可以收到机器人回复。

## 七、绑定群组
  
把机器人拉入 *准备操作* 中创建的群组并设为管理员，必须授予 `管理话题` 权限。

一般情况下，机器人会自动绑定群组。如果自动绑定没有生效，请在群组中发送 `/bind` 命令手动绑定。

一切准备就绪，可以开始使用了！

-----

### 附：更新自部署机器人教程

* **若使用 GitHub 导入**：在个人 Fork 仓库点击 `Sync fork` 即可自动同步更新并重新部署。
* **若使用网页在线编辑**：前往 `Cloudflare Dashboard`->`Workers & Pages`->`relaygobot`，点击右上角 `Edit Code`（`编辑代码`），将代码替换为最新版的 [worker.js](https://github.com/abcxyz-123456/RelayGo/blob/main/worker.js) ，并点击右上角 `Deploy`（`部署`）。

部署成功后，最新版本的机器人将立即生效。
