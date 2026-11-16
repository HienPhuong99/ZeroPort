# ZeroPort — Kế hoạch

Điều khiển máy tính từ xa cho **một chủ sở hữu**, phi thương mại. Máy bị điều khiển (host): Windows, macOS.
Máy điều khiển (controller): Windows, macOS, iOS, Android. Không cần mở port, không cần tự chạy server.

## 1. Kiến trúc (đã chốt 2026-11-16)

```
 Controller (web/PWA, cũng nhúng trong app desktop)          Host (app Electron)
 ┌───────────────────────────────┐   signaling (đã mã hoá)   ┌──────────────────────────────┐
 │ <video> + bắt chuột/phím/chạm │ ◄──── Supabase Realtime ─►│ Chromium: chụp màn hình,      │
 │ RTCPeerConnection             │                           │ mã hoá video, WebRTC          │
 │                               │ ◄══ WebRTC P2P (DTLS) ═══►│ Node main: bơm chuột/phím     │
 └───────────────────────────────┘   video+audio+data        │ (koffi → SendInput/CGEvent)   │
                                                             └──────────────────────────────┘
```

| Phần | Chọn | Lý do |
|---|---|---|
| Host | Electron 45 | Chromium lo chụp màn hình, mã hoá phần cứng, WebRTC, xuyên NAT — không phải tự viết |
| Bơm input | koffi (FFI) gọi thẳng `SendInput` / `CGEventPost` | Có sẵn binary cho Win/Mac, không cần Visual Studio |
| Controller | 1 web app tĩnh (Vite + TypeScript, không framework) | Chạy trên iOS Safari, Android Chrome, trình duyệt desktop, và nhúng trong Electron — một codebase |
| iOS/Android | PWA "Thêm vào màn hình chính" | App iOS native cần Mac + tài khoản Apple 99$/năm; PWA thì không. APK Android (Capacitor) build bằng CI — làm sau |
| Signaling | Supabase Realtime (project miễn phí của chính chủ) | Không phải viết/nuôi server; đã có sẵn tài khoản |
| Hosting controller | GitHub Pages | HTTPS miễn phí từ repo public |
| Relay (TURN) | Mặc định chỉ STUN; TURN là tuỳ chọn cấu hình trên host | TURN cần chủ đăng ký tài khoản (Cloudflare/Metered) — xem mục 6 |

### Vì sao không fork RustDesk
RustDesk làm được việc này, nhưng là ~200k dòng Rust+Flutter, build nặng, và iOS vẫn cần tài khoản Apple.
ZeroPort đi đường ngắn nhất: để Chromium làm 90% việc, phần tự viết chỉ là giao thức, bơm input và giao diện.

## 2. Bảo mật

Coi **signaling, TURN và repo public là không tin cậy**.

- Ghép cặp một lần: host tạo mã bí mật 256-bit, hiện QR / link `…/#p=v1.<hostId>.<devId>.<S>`. Bí mật nằm ở phần `#fragment`, không bao giờ đi qua mạng.
- Từ `S` dẫn xuất (HKDF-SHA-256) hai khoá: `Ksig` (AES-GCM, niêm phong mọi tin signaling) và `Kauth` (HMAC, xác thực hai chiều trên data channel, gắn với dấu vân tay DTLS của hai phía).
- Host là bên tạo offer; cấu hình ICE/TURN nằm trên host và gửi cho controller trong tin đã niêm phong → không có bí mật nào trong repo hay trên GitHub Pages.
- Video và input chỉ bật sau khi xác thực trên data channel thành công.
- Danh sách thiết bị đã ghép trên host chính là allow-list; thu hồi = xoá dòng.
- Media đi P2P qua DTLS-SRTP; TURN (nếu dùng) chỉ thấy bản mã.

Luồng kết nối:

```
C → H  hello  {sid, ts}                    (niêm phong bằng Ksig)
H → C  offer  {sid, sdp, iceServers}
C → H  answer {sid, sdp}        + ice trickle hai chiều
── data channel "ctl" mở ──
H → C  chal {nh}
C → H  auth {nc, HMAC(Kauth, "zp1|c2h"|nh|nc|fpH|fpC|sid)}
H → C  ok   {HMAC(Kauth, "zp1|h2c"|nc|nh|fpH|fpC|sid)}   → bật video + input
```

## 3. Giới hạn đã biết của v1 (nói thẳng)

- **Màn hình khoá, màn hình đăng nhập, hộp thoại UAC, Ctrl+Alt+Del**: tiến trình người dùng không chụp/điều khiển được (Windows vẽ chúng trên secure desktop). Muốn có cần một service chạy quyền SYSTEM — để giai đoạn 2. Trước mắt: host tự chạy khi đăng nhập, giữ máy không ngủ; chủ máy tự quyết định có bật auto-logon / không khoá máy hay không (đánh đổi an toàn vật lý — app không tự đổi cài đặt bảo mật Windows).
- **Cửa sổ chạy quyền admin** (Task Manager, trình cài đặt): không bơm input được trừ khi host chạy elevated (tuỳ chọn "chế độ nâng quyền" bằng Scheduled Task — chủ máy tự bật).
- **macOS host**: build bằng GitHub Actions, ký ad-hoc. Chưa test được trên máy thật (không có Mac). Mỗi lần cập nhật phải cấp lại quyền Screen Recording + Accessibility. Coi là "có người ngồi máy" cho tới khi test thật.
- **iOS**: Safari treo WebRTC khi app xuống nền → tự kết nối lại khi quay lại. iPhone không có Fullscreen API → cài PWA ra màn hình chính để toàn màn hình. Clipboard trên iOS phải bấm nút (Safari không cho tự động).
- **Supabase free**: project tạm dừng sau 7 ngày không hoạt động → host gọi `ping()` định kỳ để giữ sống. Nếu mọi host tắt >7 ngày thì phải mở lại project.
- **Không có TURN**: 4G IPv4 (CGNAT) ↔ mạng công ty chặn UDP có thể không nối được. Phần lớn mạng VN đã có IPv6 nên STUN thường đủ.

## 4. Tính năng — gom từ các gói trả phí

Nguồn khảo sát: bảng giá AnyViewer và UltraViewer (đọc trực tiếp 2026-11-16).
AnyDesk / TeamViewer / Splashtop / Parsec / RustDesk Pro: theo hiểu biết sẵn có, **chưa đối chiếu lại hôm nay** (2 agent khảo sát bị ngắt do chạm giới hạn sử dụng) — sẽ chạy lại khi còn quota.

### Tự có nhờ tự sở hữu (các app khác giới hạn ở bản free)
Không giới hạn thiết bị, số phiên, thời gian phiên; không quảng cáo; không bị "phát hiện dùng thương mại"; không bị hạ ưu tiên giờ cao điểm.

### P0 — cần để làm việc hằng ngày
| # | Tính năng | Trả phí ở | Cách làm trong ZeroPort | Trạng thái |
|---|---|---|---|---|
| 1 | Truy cập không cần người ngồi máy | tất cả | Ghép cặp một lần, host chạy nền ở khay hệ thống | ☐ |
| 2 | Danh sách thiết bị + trạng thái online | UltraViewer Pro, AnyViewer, AnyDesk | Lưu cục bộ trên controller; online qua Realtime Presence | ☐ |
| 3 | Hình ảnh chất lượng cao, tới 60fps, độ phân giải gốc/4K | AnyViewer, UltraViewer Premium, Splashtop | Chọn preset bitrate/fps, chế độ "nét chữ" / "mượt" | ☐ |
| 4 | Âm thanh máy host | UltraViewer Pro | `getDisplayMedia` audio loopback (Windows; macOS thử nghiệm) | ☐ |
| 5 | Chuột, phím, phím đặc biệt, gõ Unicode/tiếng Việt | — | Scancode + `KEYEVENTF_UNICODE`; mobile: bàn phím ảo + thanh phím | ☐ |
| 6 | Đồng bộ clipboard | — | Tự động trên Electron/Chrome; nút bấm trên iOS | ☐ |
| 7 | Truyền file hai chiều, không giới hạn dung lượng/tốc độ | AnyViewer (100MB, 500KB/s ở free), UltraViewer (1GB) | Chia khối qua data channel có backpressure | ☐ |
| 8 | Chuyển giữa nhiều màn hình | AnyDesk, TeamViewer | `replaceTrack` không cần thương lượng lại | ☐ |
| 9 | Chống ngủ, tự chạy khi đăng nhập, tự kết nối lại | UltraViewer Lite+ | `powerSaveBlocker`, login item, reconnect | ☐ |
| 10 | Điều khiển từ điện thoại (trackpad, pinch-zoom, cuộn 2 ngón) | — | Pointer Events trong PWA | ☐ |

### P1 — tiện, rẻ để làm
| # | Tính năng | Trả phí ở | Cách làm | Trạng thái |
|---|---|---|---|---|
| 11 | Ghi hình phiên | UltraViewer Premium, AnyDesk, TeamViewer | `MediaRecorder` trên controller → tải .webm | ☐ |
| 12 | Chụp ảnh màn hình | — | canvas → PNG | ☐ |
| 13 | Chế độ riêng tư (đen màn hình host + chặn chuột/phím tại chỗ) | AnyViewer, AnyDesk, TeamViewer | Cửa sổ đen phủ kín có `setContentProtection` (không lọt vào luồng chụp) + `BlockInput` khi elevated; chỉ Windows | ☐ |
| 14 | Phím tắt hệ thống từ xa: khoá máy, Task Manager, khởi động lại, tắt máy | AnyViewer (free), AnyDesk | Lệnh qua data channel | ☐ |
| 15 | Chuột game (chuột tương đối) | AnyViewer | Pointer Lock → `MOUSEEVENTF_MOVE` tương đối | ☐ |
| 16 | Terminal từ xa | AnyDesk, RustDesk | spawn shell, stdin/stdout qua data channel | ☐ |
| 17 | Thông tin hệ thống / tiến trình | TeamViewer | `os` + `tasklist`/`ps` | ☐ |
| 18 | Wake-on-LAN | UltraViewer, AnyDesk, TeamViewer | Một host khác cùng LAN gửi magic packet (`node:dgram`) | ☐ |
| 19 | Xác thực 2 lớp (TOTP) khi kết nối | AnyDesk, AnyViewer | Kiểm tra trên host sau bước xác thực khoá thiết bị | ☐ |
| 20 | Khoá máy khi ngắt kết nối | AnyDesk | `LockWorkStation` (tuỳ chọn; lưu ý v1 không mở khoá lại được từ xa) | ☐ |
| 21 | Chế độ tiết kiệm băng thông | AnyViewer (đen trắng) | Preset giảm độ phân giải/fps/bitrate | ☐ |
| 22 | Nhiều phiên cùng lúc | AnyViewer, UltraViewer Premium | Mỗi phiên một tab/cửa sổ | ☐ |
| 23 | APK Android | — | Capacitor, build trên GitHub Actions | ☐ |

### P2 — để sau
Màu 4:4:4 (VP9 profile 1/AV1), tường màn hình (xem nhiều máy cùng lúc), chuyển tiếp cổng TCP (chỉ controller Electron), in từ xa (in ra PDF rồi tự tải về), bảng vẽ chú thích, service SYSTEM cho màn hình khoá/UAC.

### Bỏ
| Tính năng | Lý do |
|---|---|
| Chat, phân quyền vai trò, triển khai hàng loạt MSI, tài khoản con, thương hiệu riêng | Vô nghĩa với một người dùng |
| Màn hình ảo, gamepad/USB redirect, micro passthrough thật | Cần driver kernel/âm thanh ảo — trái với "không cài gì phức tạp" |
| Điều khiển điện thoại từ máy tính | Cần app native trên điện thoại; iOS không cho |

## 5. Lộ trình (mỗi mốc = commit + push)

1. **M0** Kế hoạch + khung repo. ← đang ở đây
2. **M1** Lõi: giao thức, mã hoá, signaling; host chụp màn hình + bơm input; controller xem + điều khiển; test trên máy này.
3. **M2** P0 còn lại: clipboard, file, đa màn hình, âm thanh, preset chất lượng, UX mobile.
4. **M3** CI: deploy controller lên GitHub Pages; build installer Windows + DMG macOS; phát hành.
5. **M4** P1: ghi hình, chế độ riêng tư, terminal, WoL, TOTP…
6. **M5** APK Android; review bảo mật; P2 theo nhu cầu.

## 6. Việc chỉ chủ máy làm được (không chặn tiến độ)

- **Bật TURN (tuỳ chọn)**: đăng ký Cloudflare → Realtime → TURN, dán khoá vào phần cài đặt host. Chỉ cần khi gặp mạng không nối trực tiếp được.
- **Trên Mac**: cấp quyền Screen Recording + Accessibility; chạy `xattr -dr com.apple.quarantine /Applications/ZeroPort.app` lần đầu.
- **Windows không người**: tự quyết định auto-logon / không khoá máy.
- **Ghép cặp**: quét QR trên màn hình host một lần cho mỗi thiết bị điều khiển.
