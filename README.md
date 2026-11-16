# ZeroPort

Điều khiển máy tính từ xa cho cá nhân — Windows / macOS (host), Windows / macOS / iOS / Android (điều khiển).
Không mở port, không tự chạy server, mã hoá đầu-cuối. Phi thương mại.

- Kế hoạch, kiến trúc, danh sách tính năng: [docs/PLAN.md](docs/PLAN.md)
- Controller web / PWA: https://hienphuong99.github.io/ZeroPort/
- Trạng thái: hoàn tất M0–M5 (host Windows/macOS, controller web/PWA/desktop/Android APK, P0–P1 và các tính năng P2 không cần driver).

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

`npm run e2e` mở hai bản app trên cùng máy, ghép cặp, kết nối thật và di chuột thật trong chốc lát.
