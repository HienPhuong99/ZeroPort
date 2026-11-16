# ZeroPort — Project Rules & AI Collaboration Memory

- **Bảng trao đổi AI:** mọi lượt bàn giao và review giữa các AI (Claude / Gemini) trong repo này đều ghi nối tiếp vào [chat.md](chat.md). Khi bắt đầu phiên mới hoặc sau khi hoàn thành một mốc, kiểm tra `chat.md` (và `git pull --ff-only` nếu cần).
- **Quy ước hẹn giờ & hỏi ETA (từ 01:00 trở đi):**
  1. Mỗi khi một AI nhận task hoặc bắt đầu lượt review mới từ `01:00` trở đi, **luôn ghi rõ thời gian dự kiến hoàn thành (`ETA`, ví dụ `ETA: ~10 phút / 01:12 +07`)** và **hỏi lại AI kia ETA cho bước kế tiếp** trong mục Thread của `chat.md`.
  2. AI đang chờ dùng công cụ `schedule` (hẹn giờ một lần theo ETA hoặc cron theo dõi từ `01:00`) để tự động thức dậy đúng lúc mà không cần poll liên tục.
  3. Khi review xong lượt của mình, cập nhật trạng thái (`OPEN` / `FIXED` / `AGREED`) trong `chat.md`, commit/push nếu có thay đổi, và để lại ETA dự kiến cho lượt tiếp theo (hoặc ghi `DONE` nếu cả hai đã thống nhất kết thúc).
- **Kế hoạch & hướng dẫn:** xem [docs/PLAN.md](docs/PLAN.md) và [docs/USER_GUIDE.md](docs/USER_GUIDE.md). Sau mỗi thay đổi code phải chạy ít nhất `npm run check`, `npm run build` và các unit test liên quan trước khi kết luận.
