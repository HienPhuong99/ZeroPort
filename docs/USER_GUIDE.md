# Hướng dẫn sử dụng ZeroPort

ZeroPort là công cụ điều khiển máy tính từ xa cho cá nhân, mã hoá đầu-cuối, không cần mở port router và không cần tự thuê server.

---

## 1. Cài đặt trên các thiết bị

Tải bản cài đặt mới nhất tại: https://github.com/HienPhuong99/ZeroPort/releases/tag/v0.2.0

### A. Máy bị điều khiển (Host)
1. **Windows:** tải và chạy `ZeroPort.Setup.0.2.0.exe`.
   - Vì ứng dụng chưa ký số thương mại, Windows SmartScreen có thể cảnh báo: bấm **More info → Run anyway**.
   - Khi đóng cửa sổ bằng nút `✕`, ZeroPort **không tắt** mà thu nhỏ xuống khay hệ thống (System Tray) để tiếp tục chờ kết nối. Muốn thoát hẳn: chuột phải icon khay hệ thống → **Thoát**.
2. **macOS:** tải `ZeroPort-0.2.0-arm64.dmg` (Apple Silicon M1/M2/M3/M4) hoặc `ZeroPort-0.2.0.dmg` (Intel).
   - Kéo **ZeroPort.app** vào thư mục **Applications**.
   - Vì bản macOS ký ad-hoc, mở Terminal chạy lệnh sau trong lần đầu cài:
     ```bash
     xattr -dr com.apple.quarantine /Applications/ZeroPort.app
     ```
   - Vào **System Settings → Privacy & Security** cấp 2 quyền cho ZeroPort:
     - **Screen Recording** (chụp màn hình)
     - **Accessibility** (điều khiển chuột/bàn phím)
   - *(Lưu ý: mỗi lần cập nhật bản mới ký ad-hoc trên macOS, có thể cần cấp lại 2 quyền này.)*

### B. Thiết bị điều khiển (Controller)
Bạn có thể dùng bất kỳ thiết bị nào sau đây:
- **Trình duyệt máy tính (Windows / macOS / Linux):** mở https://hienphuong99.github.io/ZeroPort/
- **iPhone / iPad (iOS Safari):** mở https://hienphuong99.github.io/ZeroPort/ → bấm nút **Chia sẻ (Share)** → **Thêm vào Màn hình chính (Add to Home Screen)** để chạy toàn màn hình như app.
- **Android:** tải và cài `ZeroPort-android.apk` (bật cho phép cài từ nguồn không xác định nếu Android hỏi), hoặc dùng Chrome mở link web trên. Từ bản `v0.2.2` APK được ký bằng một khoá cố định nên cài đè lên bản cũ được; riêng lần đầu chuyển từ `v0.2.0`/`v0.2.1` phải gỡ bản cũ trước (và ghép cặp lại).
- **App desktop Electron:** chính app ZeroPort trên Windows/macOS vừa làm host vừa làm controller để điều khiển máy khác.

---

## 2. Ghép cặp lần đầu (một lần cho mỗi thiết bị)

Mã ghép cặp chứa khoá bí mật ở phần `#fragment` (không bao giờ gửi qua mạng).

1. Trên **máy cần được điều khiển (host)**, mở ZeroPort → mục **Máy này** → bấm **Ghép thiết bị mới**.
2. Nhập tên gợi nhớ cho thiết bị sẽ điều khiển (ví dụ: `iPhone`, `Laptop`) → bấm **OK**.
3. Màn hình hiện mã QR và chuỗi mã `v1....`:
   - **Nếu dùng điện thoại:** quét mã QR → mở link trong Safari/Chrome (hoặc sao chép mã dán vào app Android).
   - **Nếu dùng máy tính / app khác:** bấm **Sao chép mã**, dán vào ô **Dán mã hoặc link ghép cặp** ở phần **Máy của tôi** trên thiết bị điều khiển → bấm **Thêm**.
4. Sau khi ghép xong, máy sẽ xuất hiện trong **Máy của tôi** kèm chấm trạng thái:
   - Chấm **xanh (`Trực tuyến`)**: máy host đang bật và sẵn sàng kết nối.
   - Chấm **xám (`Ngoại tuyến`)**: máy host đang tắt, ngủ hoặc mất mạng.

> **Thu hồi quyền:** Trên máy host, dưới mục **Máy này** có danh sách thiết bị đã ghép và thời điểm kết nối gần nhất. Bấm **Thu hồi** bất kỳ lúc nào để ngắt kết nối ngay và chặn thiết bị đó kết nối lại.

---

## 3. Cài đặt trên máy host (bấm nút `⚙` ở mục Máy này)

- **Tên máy:** tên hiển thị khi ghép cặp và trong danh sách thiết bị.
- **Tự chạy khi đăng nhập (ẩn ở khay hệ thống):** tự khởi động cùng hệ điều hành và thu gọn xuống khay (chỉ có tác dụng trên bản đã cài đặt).
- **Khoá máy khi người cuối cùng ngắt kết nối:** tự khoá màn hình host (`LockWorkStation` / ngủ màn hình macOS) ngay khi bạn đóng phiên điều khiển cuối. *(Lưu ý: xem mục giới hạn bên dưới nếu dùng từ xa không có người ngồi máy.)*
- **Xác thực 2 lớp (TOTP):**
  1. Bấm **Bật 2FA…**, quét QR bằng Google Authenticator / 1Password / Bitwarden.
  2. Nhập mã 6 số để kích hoạt.
  3. Từ đó, mỗi lần điều khiển sẽ hỏi thêm mã 6 số (nhớ trong 10 phút cho cùng thiết bị nếu kết nối lại nhanh; tự khoá tạm 15 phút nếu nhập sai 10 lần).
- **Máy chủ TURN/STUN:** mặc định để trống (dùng STUN miễn phí, đi P2P trực tiếp). Chỉ cần dán mảng JSON `[{"urls":"turn:...","username":"...","credential":"..."}]` (ví dụ lấy từ Cloudflare Calls/Realtime) nếu bạn hay kết nối qua mạng công ty chặn UDP hoặc 4G CGNAT không nối trực tiếp được.

---

## 4. Điều khiển phiên từ xa

Trên thẻ máy ở **Máy của tôi**:
- Bấm **Kết nối** để mở phiên điều khiển.
- Bấm **`⧉`** để mở phiên ở cửa sổ/tab riêng — dùng khi muốn điều khiển **nhiều máy cùng lúc**.
- Nếu có từ **2 máy trở lên**, bấm **Tường màn hình** để xem trực tiếp lưới nhiều máy cùng lúc; bấm vào một ô bất kỳ để chuyển sang điều khiển toàn màn hình máy đó.

### Thanh công cụ trong phiên
- **`☰`**: thu gọn/mở thanh công cụ.
- **`Phím`**: bảng phím bổ trợ giữ (`Ctrl`, `Alt`, `Shift`) và phím đặc biệt (`Esc`, `Tab`, `Del`, `Win`, mũi tên, `Alt+Tab`, `Alt+F4`, `Win+D`, `Task Mgr`, `F1–F12`). Bấm giữ `Ctrl`/`Alt`/`Shift` rồi bấm phím kế tiếp để gửi tổ hợp phím (kể cả từ bàn phím điện thoại).
- **`⌨` và `Trackpad`/`Chạm`** *(chỉ hiện trên thiết bị cảm ứng)*: bật/tắt bàn phím ảo (hỗ trợ gõ tiếng Việt Telex/VNI) và chuyển giữa chế độ **Trackpad** (mặc định, dễ bấm chính xác) và **Chạm trực tiếp**.
- **`Màn hình`** *(chỉ hiện khi host có từ 2 màn hình trở lên)*: chuyển qua lại giữa các màn hình.
- **`Chất lượng`**:
  - `Cân bằng` (8 Mbps, 60fps)
  - `Nét nhất` (25 Mbps, 60fps)
  - `Mượt` (8 Mbps, 60fps, ưu tiên khung hình)
  - `Tiết kiệm` (1.2 Mbps, 24fps, giảm độ phân giải)
  - `AV1 (chữ nét)` (30 Mbps, 60fps, dùng codec AV1 cho chữ nét hơn; máy chủ mã hoá bằng CPU nên tốn tài nguyên hơn — tự nối lại phiên khi bật/tắt). Lưu ý: đây không phải màu 4:4:4, Chromium chưa mã hoá được 4:4:4.
- **`🔇` / `🔊`**: bật/tắt âm thanh từ máy host (mặc định tắt tiếng lúc mới vào).
- **`⛶`**: toàn màn hình (trên trình duyệt máy tính hỗ trợ khoá phím để `Alt+Tab`, `Win`, `Esc` đi thẳng vào máy host).
- **`ⓘ`**: hiện thông số thời gian thực (độ phân giải, fps, codec, bitrate, ping ms, kết nối trực tiếp hay qua relay).
- **`Ngắt`**: kết thúc phiên.

### Thao tác cảm ứng trên điện thoại / máy tính bảng
- **1 ngón chạm:** chuột trái.
- **1 ngón chạm 2 lần rồi giữ và kéo:** kéo-thả cửa sổ / bôi đen.
- **1 ngón giữ yên (~0.5 giây) hoặc 2 ngón chạm:** chuột phải.
- **2 ngón chụm / mở:** phóng to / thu nhỏ màn hình (tới 6x).
- **2 ngón vuốt:** cuộn trang.
- **3 ngón chạm:** mở/ẩn bàn phím ảo.

### Các công cụ trong mục `Thêm`
- **Gửi tệp lên máy chủ:** chọn tệp (hoặc kéo-thả thẳng tệp từ máy tính vào màn hình đang điều khiển). Tệp được lưu vào thư mục `Downloads/ZeroPort` trên máy host (tự đánh số nếu trùng tên, không ghi đè).
- **Lấy tệp từ máy chủ:** mở hộp thoại chọn tệp trên màn hình host để bạn bấm chọn và tải về thiết bị điều khiển.
- **Gửi clipboard → máy chủ / Lấy clipboard ← máy chủ:** trên máy tính/Android Chrome, clipboard tự đồng bộ khi chuyển cửa sổ hoặc nhấn `Ctrl+V`; trên iOS Safari cần bấm tay 2 nút này vì trình duyệt chặn đọc/ghi clipboard nền.
- **Chụp ảnh màn hình:** lưu ảnh PNG ngay về máy điều khiển.
- **Ghi hình phiên / Dừng ghi:** ghi video phiên điều khiển và tải file `.webm`/`.mp4` khi dừng.
- **Chế độ riêng tư:** phủ đen toàn bộ màn hình máy host (người ngồi cạnh máy host chỉ thấy màn hình đen, còn bạn vẫn nhìn và điều khiển bình thường).
  - *Lưu ý:* trên Windows, việc **chặn chuột/phím tại chỗ** (`BlockInput`) chỉ có hiệu lực nếu app ZeroPort trên host được chạy bằng quyền Administrator; tổ hợp `Ctrl+Alt+Del` luôn thoát chế độ chặn theo quy định bảo mật của Windows. Khi người điều khiển ngắt kết nối, màn hình đen tự tắt ngay.
- **Khoá / nguồn…:** gửi lệnh `Khoá máy`, `Đăng xuất`, `Khởi động lại`, `Tắt máy` (có hộp thoại xác nhận cho các lệnh nguồn).
- **Thông tin hệ thống:** xem CPU, RAM, uptime, danh sách 60 tiến trình tốn RAM nhất và nút **Dừng** tiến trình.
- **Terminal:** mở dòng lệnh từ xa (`cmd.exe` trên Windows, shell trên macOS) kèm nút **Mở lại** để ngắt lệnh đang kẹt và tạo shell mới. *(Dùng cho lệnh dòng; không hỗ trợ ứng dụng TUI toàn màn hình như `vim`.)*
- **Chuột game (khoá con trỏ)** *(chỉ trên máy tính)*: dùng Pointer Lock gửi di chuyển chuột tương đối cho game/3D; bấm `Esc` để thoát.
- **Đánh thức máy khác (Wake-on-LAN):** nhờ một máy host đang online gửi gói đánh thức (magic packet) tới máy khác trong cùng mạng LAN. ZeroPort tự lưu địa chỉ MAC của mỗi host sau lần kết nối đầu tiên; bạn cũng có thể nhập MAC thủ công.
- **Bảng vẽ chú thích:** chọn màu và vẽ trực tiếp lên màn hình để chỉ dẫn cho người ngồi ở máy host (hiển thị bằng lớp phủ trong suốt, không làm bấm nhầm vào cửa sổ bên dưới); có nút **Xoá** và **Thoát vẽ**.
- **Chuyển tiếp cổng TCP** *(chỉ khi điều khiển bằng app desktop Electron)*: chuyển tiếp cổng cục bộ `127.0.0.1:<cổng máy này>` sang `127.0.0.1:<cổng máy chủ>` (ví dụ `2222 → 22` cho SSH hoặc xem web local trên máy host).

---

## 5. Giới hạn cần biết & Mẹo vận hành không người

1. **Màn hình khoá Windows, màn hình đăng nhập, hộp thoại UAC, `Ctrl+Alt+Del`:**
   - Do ZeroPort chạy ở quyền người dùng thường (không cài service `SYSTEM`), Windows vẽ các màn hình bảo mật này trên desktop riêng nên app không chụp và không bấm được vào đó.
   - Nếu máy Windows ở nhà không có ai bấm mở khoá, hãy cân nhắc **không bật khoá màn hình tự động** và **không dùng tuỳ chọn "Khoá máy khi ngắt kết nối"** (đổi lại, hãy đảm bảo an toàn vật lý tại nơi đặt máy).
2. **Cửa sổ chạy quyền Admin (Task Manager, trình cài đặt):**
   - Windows chặn tiến trình thường gửi chuột/phím vào cửa sổ đang chạy quyền Admin (UIPI). Nếu cần thao tác các cửa sổ này, hãy chạy ZeroPort trên host với quyền Administrator (hoặc qua Task Scheduler).
3. **iPhone / iPad khi chuyển sang app khác:**
   - iOS tạm dừng kết nối WebRTC khi Safari/PWA xuống nền. Khi bạn quay lại ZeroPort, app sẽ tự kết nối lại ngay.
4. **Supabase gói miễn phí:**
   - Nếu toàn bộ máy host đều tắt liên tục quá **7 ngày**, dự án Supabase dùng cho signaling có thể bị tạm dừng (pause); chỉ cần mở trang quản trị Supabase bấm **Restore** là chạy lại. Khi có ít nhất một host bật, app tự gọi `ping()` định kỳ 6 giờ/lần để giữ dự án hoạt động.
