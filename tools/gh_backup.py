#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gh_backup.py —— 任意目录一键备份到 GitHub（供多个 Hermes 机器人共用）

用法：
  python gh_backup.py --dir C:\\Users\\Administrator\\某项目 --name 我的仓库 --public
  python gh_backup.py --dir . --name my-repo --private --desc "项目说明"
  python gh_backup.py --dir . --name my-repo --dry-run     # 只检查不推送

特性：
  · 自动找 gh（PATH 找不到就用默认安装路径）
  · 复用已有的 gh 登录（token 在 Windows 凭据管理器里，全 OS 用户共享，无需重复授权）
  · 推送前做敏感信息扫描，发现私钥/密钥直接拒绝
  · .gitignore 自动补齐保护项（keys/ .env config.json data/ logs/）
  · 仓库不存在则创建，存在则 push
"""
import argparse
import os
import re
import subprocess
import sys

GH_CANDIDATES = [
    "gh",
    r"C:\Program Files\GitHub CLI\gh.exe",
    r"C:\Program Files (x86)\GitHub CLI\gh.exe",
]

# 这些文件/目录绝不能进仓库
FORBIDDEN_DIRS = {"keys", "data", "logs", "reports", "node_modules", "__pycache__", ".venv", "venv"}
FORBIDDEN_FILES = {"wallet.json", ".env", "config.json", "id_rsa", "id_ed25519"}
FORBIDDEN_PATTERNS = [
    (re.compile(r"api-key=[A-Za-z0-9]{16,}"), "疑似真实 API Key"),
    (re.compile(r"\bgh[opsu]_[A-Za-z0-9]{30,}\b"), "疑似 GitHub token"),
    # 私钥是 64 个 0-255 的整数数组；要求至少 16 个连续数字才判定，避免误报 [30, 85, 0.99]
    (re.compile(r"\[\s*(?:\d{1,3}\s*,\s*){16,}\d{1,3}\s*\]"), "疑似私钥字节数组"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "疑似 PEM 私钥"),
]
GITIGNORE_DEFAULTS = [
    "keys/", "wallet.json", "*.key", ".env", "config.json",
    "data/", "logs/", "node_modules/", "__pycache__/", "*.pyc", "*.pid", "*.jsonl",
]


def find_gh():
    for c in GH_CANDIDATES:
        try:
            r = subprocess.run([c, "--version"], capture_output=True, text=True, timeout=15)
            if r.returncode == 0:
                return c
        except Exception:
            continue
    return None


def run(cmd, cwd=None, check=False):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=300)
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)}\n{r.stdout}\n{r.stderr}")
    return r


def git_files(root):
    """git 实际会提交的文件（尊重 .gitignore）"""
    r = run(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=root)
    return [f for f in r.stdout.split(chr(0)) if f.strip()]


def scan_secrets(root, files):
    """只扫描真正会被提交的文件，返回问题列表"""
    problems = []
    for rel in files:
        full = os.path.join(root, rel)
        if not os.path.isfile(full):
            continue
        name = os.path.basename(rel)
        if name in FORBIDDEN_FILES:
            problems.append(f"敏感文件会被提交: {rel}（请加进 .gitignore）")
            continue
        if os.path.getsize(full) > 2_000_000:
            continue
        try:
            txt = open(full, encoding="utf-8", errors="ignore").read()
        except Exception:
            continue
        for pat, why in FORBIDDEN_PATTERNS:
            if pat.search(txt):
                problems.append(f"{why}: {rel}")
                break
    return problems


def ensure_gitignore(root):
    p = os.path.join(root, ".gitignore")
    cur = open(p, encoding="utf-8", errors="ignore").read() if os.path.exists(p) else ""
    add = [l for l in GITIGNORE_DEFAULTS if l not in cur]
    if add:
        with open(p, "a", encoding="utf-8") as f:
            if cur and not cur.endswith("\n"):
                f.write("\n")
            f.write("\n# --- gh_backup 自动补充 ---\n" + "\n".join(add) + "\n")
    return add


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="要备份的目录")
    ap.add_argument("--name", required=True, help="GitHub 仓库名")
    ap.add_argument("--desc", default="", help="仓库描述")
    ap.add_argument("--public", action="store_true", help="公开（默认私有）")
    ap.add_argument("--dry-run", action="store_true", help="只检查，不推送")
    a = ap.parse_args()

    root = os.path.abspath(a.dir)
    if not os.path.isdir(root):
        print(f"[X] 目录不存在: {root}")
        return 1

    gh = find_gh()
    if not gh:
        print("[X] 找不到 gh。安装：winget install --id GitHub.cli -e --silent < /dev/null")
        print("    或用全路径 C:\\Program Files\\GitHub CLI\\gh.exe")
        return 1

    st = run([gh, "auth", "status"])
    if st.returncode != 0:
        print("[X] gh 未登录。先跑一次：gh auth login --web")
        print(st.stdout + st.stderr)
        return 1
    m = re.search(r"account (\S+)", st.stdout + st.stderr)
    who = m.group(1) if m else "?"
    print(f"[1/5] gh 就绪，账号 {who}")

    print(f"[2/5] 检查目录 {root}")
    added = ensure_gitignore(root)
    if added:
        print(f"      .gitignore 补充: {', '.join(added)}")

    if not os.path.isdir(os.path.join(root, ".git")):
        run(["git", "init"], cwd=root, check=True)
        print("      git init")
    files = git_files(root)
    print(f"      待提交 {len(files)} 个文件")
    problems = scan_secrets(root, files)
    if problems:
        print("[X] 发现敏感内容，已中止（请先加进 .gitignore 或删除）：")
        for p in problems[:15]:
            print("      -", p)
        return 2
    print("      敏感信息扫描通过")

    if a.dry_run:
        print("[3/5] --dry-run，到此为止")
        return 0

    print("[3/5] 提交")
    run(["git", "add", "-A"], cwd=root, check=True)
    msg = a.desc or f"backup {os.path.basename(root)}"
    r = run(["git", "-c", "user.email=bot@local", "-c", "user.name=backup-bot",
             "commit", "-m", msg], cwd=root)
    if r.returncode == 0:
        print("      已提交")
    else:
        print("      无新变更（继续推送）")

    rem = run(["git", "remote"], cwd=root)
    if "origin" in rem.stdout.split():
        print("[4/5] 已有 origin，直接 push")
        pr = run([gh, "repo", "view", "--json", "url", "--jq", ".url"], cwd=root)
        r2 = run(["git", "push", "-u", "origin", "HEAD"], cwd=root)
        if r2.returncode != 0:
            print("[X] push 失败：", (r2.stdout + r2.stderr)[:400])
            return 3
        print("[5/5] 完成 →", pr.stdout.strip() or "（已有仓库）")
        return 0

    print("[4/5] 创建远程仓库并推送")
    cmd = [gh, "repo", "create", a.name, "--source=.", "--remote=origin", "--push"]
    cmd.append("--public" if a.public else "--private")
    if a.desc:
        cmd += ["--description", a.desc]
    r3 = run(cmd, cwd=root)
    out = (r3.stdout + r3.stderr).strip()
    if r3.returncode != 0:
        print("[X] 创建失败：", out[:500])
        return 3
    url = next((l.strip() for l in out.split("\n") if "github.com" in l), out)
    print("[5/5] 完成 →", url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
