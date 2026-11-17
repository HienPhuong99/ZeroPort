# ZeroPort

Điều khiển máy tính từ xa cho cá nhân — Windows / macOS (host), Windows / macOS / iOS / Android (điều khiển).
Không mở port, không tự chạy server, mã hoá đầu-cuối. Phi thương mại.

- Hướng dẫn sử dụng chi tiết: [docs/USER_GUIDE.md](docs/USER_GUIDE.md)
- Kế hoạch, kiến trúc, danh sách tính năng: [docs/PLAN.md](docs/PLAN.md)
- Tải bản cài đặt (Windows, macOS, Android APK): https://github.com/HienPhuong99/ZeroPort/releases/latest
- Controller web / PWA: https://hienphuong99.github.io/ZeroPort/
- Trạng thái: hoàn tất M0–M7 (host Windows/macOS, controller web/PWA/desktop/Android APK + Android TV, P0–P2 không cần driver, cập nhật host từ xa, kết nối trong LAN không cần Internet, chiếu màn hình lên Smart TV qua DLNA).

## Chạy thử (dev)

```bash
npm install
npm run dev
```

App desktop (host + điều khiển):

```bash
npm run app
```

Kiểm thử:

```bash
npm test
```

```bash
npm run e2e
```

`npm run e2e` mở hai bản app trên cùng máy, ghép cặp, kết nối thật và di chuột thật trong chốc lát; sau đó thử chiếu lên một TV DLNA giả (`scripts/fake-tv.mjs`, giải mã bằng `ffmpeg` nếu có) và một cặp app không có Internet (Supabase + STUN bị chặn) chỉ nối qua LAN.
