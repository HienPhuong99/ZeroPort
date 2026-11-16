# ZeroPort

Điều khiển máy tính từ xa cho cá nhân — Windows / macOS (host), Windows / macOS / iOS / Android (điều khiển).
Không mở port, không tự chạy server, mã hoá đầu-cuối. Phi thương mại.

- Kế hoạch, kiến trúc, danh sách tính năng: [docs/PLAN.md](docs/PLAN.md)
- Trạng thái: M1 — host Windows + controller chạy được trọn tuyến (ghép cặp, mã hoá, video, chuột/phím).

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
