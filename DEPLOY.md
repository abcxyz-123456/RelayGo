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

前往 `Cloudflare Dashboard`->`Compute & AI`（`计算和 AI`）->`Workers & Pages`：

1. 点击 `Create application`（`创建应用程序`）。
2. 选择 `Start With Hello World` ，`Worker Name` 填写 `relaygobot`，点击 `Deploy`（`部署`）。
3. 部署完成后，点击右上角 `Edit Code`（`编辑代码`），将代码全部替换为 [worker.js](https://github.com/abcxyz-123456/RelayGo/blob/main/worker.js) 中的内容。
4. 点击右上角 `Deploy`（`部署`）。

## 四、绑定 KV

进入 `Workers & Pages`->`relaygobot`->`Bindings`（`绑定`）：

点击 `Add binding`（`添加绑定`），弹出菜单中选择 `KV namespace`（`KV 命名空间`），变量名称填写 `KV` ，下方选择 `relaygokv`，完成绑定。

## 五、设置环境变量

进入 `Workers & Pages`->`relaygobot`->`Settings`（`设置`）。

下滑找到 `Variables and Secrets`（`变量和机密`），填入以下变量：

| 类型 | 变量名称 | 值 |
|:----:|:-------:|:---:|
| Secret | `BOT_TOKEN` | 你的机器人 token（可以在 [@BotFather](https://t.me/BotFather) 查看 |
| Secret | `OWNER_ID` | 你的 Telegram UID（可以通过 [@getidsbot](https://t.me/getidsbot) 获取 |

## 六、设置 Telegram Webhook

打开浏览器访问（请替换链接中的`你的token`和`你的worker域名`字段）：

```
https://api.telegram.org/bot<你的token>/setWebhook?url=https://<你的worker域名>/webhook
```

示例：

```
https://api.telegram.org/bot123456:ABCDEFG/setWebhook?url=https://relaygobot.example.workers.dev/webhook
```

发送 `/start` 给你的机器人，确认可以收到机器人回复。

## 七、绑定群组
  
把机器人拉入 *准备操作* 中创建的群组并设为管理员，必须授予 `管理话题` 权限。

一般情况下，机器人会自动绑定群组。如果自动绑定没有生效，请在群组中发送 `/bind` 命令手动绑定。

一切准备就绪，可以开始使用了！
