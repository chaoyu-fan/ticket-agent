#!/usr/bin/env bash
set -euo pipefail

echo "Ticket Agent macOS preflight"
command -v node >/dev/null || { echo "缺少 Node.js 22.13+" >&2; exit 1; }
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)'; then
  echo "需要 Node.js 22.13 或更高版本，当前为 $(node --version)" >&2
  exit 1
fi

chrome_path="${TICKET_AGENT_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [ ! -x "$chrome_path" ]; then
  echo "未找到可执行的 Chrome：$chrome_path" >&2
  echo "请先安装 Google Chrome，或设置 TICKET_AGENT_CHROME。" >&2
  exit 1
fi

profile_path="${TICKET_AGENT_PROFILE:-$HOME/Library/Application Support/TicketAgent/ChromeProfile}"
sandbox_profile_path="${TICKET_AGENT_SANDBOX_PROFILE:-$HOME/Library/Application Support/TicketAgent/SandboxChromeProfile}"
normal_chrome_path="$HOME/Library/Application Support/Google/Chrome"
if ! node -e '
  const path = require("node:path");
  const resolved = process.argv.slice(1).map((value) => path.resolve(value).toLowerCase());
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
  };
  const overlaps = (left, right) => contains(left, right) || contains(right, left);
  const [live, sandbox, normal] = resolved;
  process.exit(live && sandbox && normal && !overlaps(live, sandbox) && !overlaps(live, normal) && !overlaps(sandbox, normal) ? 0 : 1);
' "$profile_path" "$sandbox_profile_path" "$normal_chrome_path"; then
  echo "profile 必须彼此隔离，且不能是日常 Chrome 目录的祖先、自身或后代" >&2
  exit 1
fi
for candidate_profile in "$profile_path" "$sandbox_profile_path"; do
  if [ -L "$candidate_profile" ]; then
    echo "profile 不能是符号链接：$candidate_profile" >&2
    exit 1
  fi
done
# Do not create or chmod custom paths in this shell preflight: mkdir/chmod can
# follow a symlink in an existing parent. The runner performs a component-wise
# lstat check, creates the directories, and applies 0700 immediately before use.
echo "Node: $(node --version)"
echo "Chrome: $chrome_path"
echo "真实专用 profile: $profile_path"
echo "仿真专用 profile: $sandbox_profile_path"
echo "预检通过。runner 将在启动时逐级检查并以 0700 创建 profile；首次登录必须由用户手动完成。"
