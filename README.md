# agy-plugins — Xưởng Phát Triển Plugin Cho Google Antigravity

Monorepo tập trung mã nguồn các plugin tùy biến cho Google Antigravity.

## Danh sách Plugin

- **[`plugins/codex-bridge/`](plugins/codex-bridge/README.md)** — Local Stdio MCP Server (Node.js >= 20, zero external runtime dependencies) kết nối Antigravity Orchestrator với Codex CLI cục bộ (`codex exec`, `codex exec resume`, `codex exec review`).

## Cài đặt nhanh trên máy mới (Quick Start)

1. **Chuẩn bị môi trường**:
   - Cài **Node.js >= 20** và **Codex CLI**, đăng nhập sẵn bằng `codex login`.
   - **Trên Windows**: mở `~/.codex/config.toml` và cấu hình sandbox để Codex CLI có thể đọc tệp trong chế độ `read-only` (tránh lỗi `rejected: blocked by policy`):
     ```toml
     [windows]
     sandbox = "unelevated"
     ```
     Sau đó chạy `codex doctor` để kiểm tra.
2. **Clone repo**:
   ```powershell
   git clone https://github.com/thanhtd-uk/agy-plugins.git
   cd agy-plugins
   ```
3. **Cài đặt & kiểm định `codex-bridge`**:
   ```powershell
   npm --prefix plugins/codex-bridge run install:plugin
   npm --prefix plugins/codex-bridge run doctor
   ```

## Cấu trúc thư mục chuẩn

```text
agy-plugins/
├── LICENSE
├── specs/                    # Đề bài, ghi chú ý tưởng & bộ Prompt từng bước cho mỗi plugin
│   └── codex-bridge.md
└── plugins/                  # Mã nguồn từng plugin độc lập
    ├── codex-bridge/         # Cầu nối Orchestrator <-> Codex CLI
    │   ├── plugin.json
    │   ├── mcp_config.json
    │   ├── rules/AGENTS.md
    │   ├── scripts/install.mjs
    │   ├── src/
    │   └── test/
    └── <plugin-tiep-theo>/
```

> **Lưu ý thiết kế:** Các plugin đang phát triển được đặt trong `plugins/<name>/` (không đặt trong `.agents/plugins/`) để code đang viết dở không bị Antigravity tự động nạp sớm. Chỉ sau khi vượt qua `agy plugin validate --strict plugins/<name>`, plugin mới được cài sang `~/.gemini/config/plugins/<name>`.
