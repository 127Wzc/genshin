# 逍遥 Stoken 迁移到 genshin

脚本 `migrate-xiaoyao-sk.sh` 使用机器人现有的 Node.js 和 `yaml` 依赖，无需额外安装工具。默认根据脚本位置寻找 Yunzai 根目录，也可以用 `--root` 指定。

## 检查和预览

在 Yunzai 根目录执行：

```bash
bash plugins/genshin/scripts/migrate-xiaoyao-sk.sh
```

脚本扫描插件中的逍遥名称、Stoken 读写方法引用，输出文件名及行号。安装地址引用不等于依赖 SK；动态拼接路径、被排除的目录或其他语言可能漏检。不会自动改动其他插件。需要人工确认候选位置实际是否读取 `plugins/xiaoyao-cvs-plugin/data/yaml`。

源目录为 `plugins/xiaoyao-cvs-plugin/data/yaml/`，目标目录为 `plugins/genshin/yaml/`。处理数字及字母、下划线、连字符组成的用户 ID 文件名（包括 `qq_`、`wxid_` 等）。按 stuid 合并账号，不输出凭据内容。

逍遥按游戏 UID 保存 SK，同一 stuid 的多条记录属于正常情况：凭据一致时折叠为一个账号，优先保留带 region 的代表记录；这不是迁移多个游戏 UID 的完整绑定关系。若同一账号的凭据不一致，则停止迁移并提示整理记录，脚本不猜测新旧。缺少 region 的旧记录可以迁入，但 genshin 的社区签到会过滤它们；脚本会提示后续重新扫码补全，不根据 UID 猜测游戏和区服。

校验失败会区分源文件和目标文件，并指出缺失字段、重复凭据冲突、用户归属或 YAML 格式等原因。错误提示不会包含 YAML 原文或凭据。

## 执行一次性迁移

先停止机器人，避免登录、刷新或删除凭据时并发写文件，再执行：

```bash
bash plugins/genshin/scripts/migrate-xiaoyao-sk.sh --apply
```

默认保留目标已有账号的数据，只添加缺失账号。脚本无法判断哪边的凭据更有效。如果明确需要以逍遥数据替换同账号数据，执行：

```bash
bash plugins/genshin/scripts/migrate-xiaoyao-sk.sh --apply --prefer-source
```

可以从任意目录指定机器人位置：

```bash
bash /path/to/migrate-xiaoyao-sk.sh --root /path/to/TRSS-Yunzai --apply
```

所有输入先校验，异常会阻止本次迁移。源文件始终保留；目标文件先备份，再逐文件原子替换，权限为 600。备份位于 Yunzai 根目录下的 `data/genshin-sk-migration-backups/<时间-进程号>/`，包含原目标文件和 `manifest.json`。若中途遇到磁盘错误，可能已写入部分文件，可根据该清单检查和恢复。

恢复时先停止机器人：将备份中 `replaced` 对应的 YAML 放回目标目录；`created` 是本次原计划新增的文件，只在确认它仍是本次迁移数据后删除。不要将 `manifest.json` 复制进账号目录。

迁移完成后启动机器人，检查扫码登录、刷新 CK 和签到。其他插件若仍从逍遥目录读取 SK，需要单独适配读取位置与格式；本脚本不会建立自动同步或软链接。以后在逍遥扫码不会自动同步到 genshin，再次迁移需要重新运行脚本。不要把凭据目录或备份提交到 Git。

## 只检测七个冲突文件中的失效 SK

针对已确认有凭据冲突的七个用户，使用：

```bash
bash plugins/genshin/scripts/check-conflicting-sk.sh
```

仅处理 `167352731`、`2077739585`、`3197519035`、`3213825110`、`3263500293`、`3323714651`、`383654257` 在逍遥源目录的文件。默认只检测，不修改。需 Node.js 18+；脚本将候选凭据发送到米游社官方 Stoken 换取 Cookie 接口，不访问第三方检测服务，也不输出凭据或返回的 Cookie。

确认结果后，先停止机器人，再执行：

```bash
bash plugins/genshin/scripts/check-conflicting-sk.sh --apply
```

脚本重新检测，只清理连续两次明确返回登录失效的凭据对应记录。有效记录以及网络错误、限流、验证码、无法确认国服等 `unknown` 记录保留。它验证的是 Stoken 换取 Cookie 的能力，不单独验证 ltoken。相同凭据的多 UID 记录只检测一次；不同米游社账号分别保留，不整份删除用户文件。

完整原文件先备份到 Yunzai 根目录下 `data/sk-check-backups/<时间-进程号>/`，再写入清理结果。仅修改七个源文件，其他用户、genshin 目标目录、Cookie 与 UID 绑定不变。若写入中途发生错误，可能部分文件已更新，可从该目录恢复。

清理后重新运行迁移脚本预览。如果同账号的多份 Stoken 都有效，或者仍有未知结果，脚本不会猜测哪份较新，也不会删除这些记录，因此可能仍存在迁移冲突，需要再选择代表凭据或重新扫码。
