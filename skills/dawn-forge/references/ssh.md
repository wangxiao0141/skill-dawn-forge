# SSH 建联与密钥

## 身份模型

始终区分：

1. 目标机的 SSH host key：证明连接到同一台 SSH server。
2. 控制机管理密钥：私钥只在控制机，用于长期管理该目标机。
3. 目标机 GitHub 专用密钥：私钥只在目标机，只向 `github.com` 提供。
4. 目标机通用密钥：私钥只在目标机，用于用户后续配置的其他主机。

不得复制、复用或交换这些私钥。

## 控制机管理密钥

使用：

```text
~/.ssh/dawn-forge/<target.id>/management_ed25519
~/.ssh/dawn-forge/<target.id>/management_ed25519.pub
```

规则：

- 两个文件均不存在时，生成专用 `ED25519` key pair。
- 为了批准后批量执行，管理密钥允许不设置 passphrase，但必须依赖控制机账号权限保护，并禁止 agent forwarding。
- 两个文件都存在时，用 `ssh-keygen -y -f <private>` 导出公钥并验证配对。
- 只存在一个文件、配对失败或权限异常时停止，不覆盖。
- public key comment 使用 `dawn-forge:<target.id>:management`，不放 email、域名或秘密。

## 目标机本地 bootstrap

以 Apple 官方 [Remote Login 指南](https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac) 为事实来源。

优先引导用户打开 `System Settings > General > Sharing > Remote Login`：

- 打开 Remote Login；
- 选择 `Only these users`；
- 只加入装机清单中的 `target.user`；
- 不开启 Full Disk Access，除非后续有具体、已确认的必要性。

也可以在用户明确选择 Terminal 方式时执行：

```bash
sudo systemsetup -setremotelogin on
```

随后生成一段包含实际管理公钥的目标机本地命令。命令必须：

```bash
umask 077
mkdir -p "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 700 "$HOME/.ssh"
chmod 600 "$HOME/.ssh/authorized_keys"
grep -qxF '<managed-authorized-key-line>' "$HOME/.ssh/authorized_keys" ||
  printf '%s\n' '<managed-authorized-key-line>' >> "$HOME/.ssh/authorized_keys"
```

管理公钥行应增加 `no-agent-forwarding,no-port-forwarding,no-X11-forwarding` 限制。替换占位符前先验证 public key 只包含预期的 `ssh-ed25519` key、Base64 blob 和受控 comment。

不要覆盖整个 `authorized_keys`。如果追加后回连失败，只能删除完整匹配的本次新增行；无法精确匹配时让用户人工检查。

## 首次连接

使用装机清单中的 user、host 和指定 IdentityFile：

```text
ssh -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes -o BatchMode=yes -i <management-key> <user>@<host>
```

- 禁止 `StrictHostKeyChecking=no`。
- 后续 host key 变化时立即停止，不自动执行 `ssh-keygen -R`。
- 禁止回退到 password、keyboard-interactive、默认 key 或 SSH agent 中的其他身份。
- 成功后验证 `id -un`、`uname -s`、`uname -m`、`hostname` 和 `sw_vers`。
- 只接受期望用户、`Darwin` 和 `arm64`。

## 目标机外部服务密钥

在 SSH 已稳定且软件安装完成后，引导用户在目标机本地 Terminal 初始化：

```text
~/.ssh/github_ed25519
~/.ssh/github_ed25519.pub
~/.ssh/id_ed25519
~/.ssh/id_ed25519.pub
```

规则：

- 使用 `ED25519`。
- passphrase 由用户在目标机本地输入；不经过 Agent、SSH 参数或日志。
- private key 已存在时绝不覆盖。缺少 `.pub` 时使用 `ssh-keygen -y` 从 private key 恢复公钥。
- 新增 key 后使用 `ssh-add --apple-use-keychain <key>` 加入 macOS Keychain；如果用户选择空 passphrase，也不要替用户改变选择。

为 GitHub 管理以下标记块，写入前备份 `~/.ssh/config`：

```sshconfig
# >>> dawn-forge github
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/github_ed25519
  IdentitiesOnly yes
  AddKeysToAgent yes
  UseKeychain yes
# <<< dawn-forge github
```

如果标记块之外已经存在匹配 `github.com` 的 `Host` 配置，先报告冲突并让用户选择保留或合并，不追加第二套竞争配置。

不为通用 `id_ed25519` 写 Host 通配规则，避免向所有服务器无条件提供身份。

展示两个 `.pub` 文件。按照 GitHub 官方 [Adding a new SSH key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/adding-a-new-ssh-key-to-your-github-account) 指南，由用户在网页添加 GitHub key；或在用户明确授权且 `gh` 已登录时执行 `gh ssh-key add`。最后用 `ssh -T git@github.com` 验证，并正确解释 GitHub 的非零成功退出行为。
