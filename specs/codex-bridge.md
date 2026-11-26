# Đặc Tả & Bộ Prompt Thực Chiến: `codex-bridge`

Mở Project `<path-to-repo>/agy-plugins` trên Antigravity, tạo **New Conversation** với model **`Orchestrator`** (`Neon` hoặc `Carbon` `Medium`/`High`) và đi lần lượt theo **3 nhịp** dưới đây (giữ nguyên cùng 1 phiên chat từ đầu đến cuối để ăn trọn Prompt Cache):

---

## Nhịp 1: Phỏng vấn chốt thiết kế với `/grill-me`

```text
/grill-me Tôi muốn thiết kế plugin đầu tiên trong monorepo này đặt tại `plugins/codex-bridge/` (Local Stdio MCP Server bằng Node.js >= 20, zero external runtime dependencies) để Orchestrator của Antigravity phối hợp trực tiếp với Codex CLI có sẵn trên máy Windows này (`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`, bản `codex-cli 0.164.0`, đã đăng nhập tại `~/.codex`, giao tiếp qua `codex exec` và `codex review` vì bản 0.164.0 không có `mcp-server`, ưu tiên model GPT 6.2 Astra).

Trước khi lập kế hoạch và viết code, hãy phỏng vấn tôi để chốt sạch các quyết định thiết kế quan trọng:
1. Vòng đời Conversation bên phía Codex: khi nào chạy `--ephemeral` (không lưu rác vào lịch sử Codex cá nhân) vs. khi nào giữ session để nối tiếp nhiều lượt qua `codex exec resume <session_id>`?
2. Quản lý thư mục làm việc (`cwd` bắt buộc truyền vào `-C` để không bị trôi về thư mục plugin) và chuẩn đóng gói ngữ cảnh bàn giao (Context Handoff) từ Orchestrator sang Codex sao cho tiết kiệm token cả 2 bên nhất.
3. Cơ chế cô lập an toàn khi giao Codex sửa code (`read-only`, sửa trực tiếp `workspace-write`, hay tách nhánh `--worktree` riêng để Orchestrator kiểm duyệt trước khi gộp).
4. Cách vượt giới hạn timeout 180 giây của MCP trong Antigravity (chuyển sang background `jobId` ở ~145s nếu Astra suy luận lâu) và cấu hình model/effort bên phía Codex.
```

---

## Nhịp 2: Chốt Bản Thiết Kế Kiến Trúc với `/plan`
*(Sau khi trả lời xong các câu hỏi của `/grill-me`, bạn KHÔNG cần dán lại đề bài dài nữa vì phiên chat đã nhớ hết — chỉ cần dán câu ngắn này):*

```text
/plan Tổng hợp toàn bộ các quyết định thiết kế vừa thống nhất thành bản kế hoạch triển khai chi tiết cho `plugins/codex-bridge/`. Đảm bảo xử lý chuẩn môi trường Windows: truyền prompt vào `codex exec -` qua stdin để tránh giới hạn độ dài dòng lệnh 8191 ký tự, lấy kết quả sạch qua `-o <tmpfile>` (giới hạn <= 8.5 KB tránh tràn context), dọn sạch cây tiến trình con khi hủy/timeout, và giữ `rules/AGENTS.md` thật gọn (< 1.5 KB). Khoan viết code, hãy xuất bản kế hoạch trước.
```

---

## Nhịp 3 (Prompt Final): Thi công, Kiểm định & Cài đặt với `/plugin`
*(Sau khi xem Artifact Plan thấy ưng ý, dán câu chốt này để hoàn thiện từ A–Z):*

```text
/plugin Triển khai trọn vẹn `plugins/codex-bridge/` theo đúng bản kế hoạch vừa chốt:
1. Viết đầy đủ mã nguồn MCP server (`eager: true` trong `mcp_config.json`), `plugin.json`, `rules/AGENTS.md`, `README.md`, script cài đặt (`install.mjs` hỗ trợ install/doctor/uninstall sang `~/.gemini/config/plugins/codex-bridge`).
2. Viết bộ unit & MCP integration tests (mock tiến trình con kiểm tra đủ luồng sync, background `jobId` timeout, `cwd` bắt buộc, stdin prompt và xử lý lỗi) rồi chạy pass 100%.
3. Chạy `agy plugin validate --strict plugins/codex-bridge` đảm bảo 0 lỗi / 0 cảnh báo, sau đó cài đặt vào `~/.gemini/config/plugins/codex-bridge` và kiểm tra Antigravity đã nhận diện thành công plugin.
```
