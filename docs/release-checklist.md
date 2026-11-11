# 发布清单（v0.8.0 → 可发布状态）

当前版本：`0.8.0`　Git tag：`v0.8.0`（commit `98a54d3`）

## 已完成

- [x] 测试全绿：`64 套件`（70 项 PASS / 0 FAIL / 2 SKIP）
      - 2 个 SKIP 是环境门槛，不是失败：缺 `assets/`、Android 不能直接 exec `.mjs`
- [x] `package.json` 的 `files` 清单修正
      - 移出 `test/`（用户不需要）
      - 加入 `docs/*.md`、`screenshots.json`
- [x] README 增加「人格稳定性与缓存约束」章节
- [x] NOTICE 补全：Live2D 模型作者（是依七哒）+ 授权链 + Live2D Cubism Core 声明
- [x] Git：`main` 分支、`origin` 已配置、tag `v0.8.0`
- [x] 本地 DSH 实例激活验证通过（`/cyrene/state` 正常返回）

## 未完成（阻塞发布）

### 1. `assets/cyrene/` 缺失

代码引用、`files` 清单、NOTICE 都写了它，但目录实际不存在
（本地副本同步时被排除，之后网络中断没补回）。

影响：桌宠加载不出来，其余功能正常。

补齐方式（网络恢复后二选一）：
```bash
# 从远端服务器拉
rsync -av root@192.168.0.102:/mnt/Storage1_sda1/cyrene/dsh-cyrene-theme/assets/ ./assets/

# 或从上游 dsh-cyrene 取（逐字节一致）
```

补齐后需要补一次 commit，并验证 `node test/host.live2d.spec.mjs` 从 SKIP 变成 PASS。

### 2. 远端实例未验证

`0.8.0` 只在本地 0.2.1-rc.2 上跑通过，远端 0.2.2-rc.1 还没验证。
两个版本的 API 有差异（远端 `dsh web` 支持 `web` 位置参数，本地不支持）。

### 3. 没能推送

`git push` 失败：`Recv failure: Software caused connection abort`
（手机网络到 GitHub 不通）。需要换网络或用代理：
```bash
git push -u origin main --tags
```

## 建议优化（不阻塞）

- 素材瘦身：`Background/` 4.1MB + `meme/` 3.0MB 每次安装都要下，
  可改成按需下载（首次启动拉取）
- `docs/screenshots/` 3.7MB 未纳入 `files`（只在仓库里，用于 README）

## 回滚方式

本地 profile 的插件注册如果出问题：

```bash
P=/data/user/0/com.dsharnessmobile.shell/files/home/.dsh/profiles/web
cp $P/package.json.bak-1229 $P/package.json
rm $P/node_modules/dsh-cyrene-theme
```

然后重启 DSH。