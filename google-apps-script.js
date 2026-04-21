/**
 * ÀlaHome — Google Apps Script (v2)
 *
 * HƯỚNG DẪN DEPLOY:
 * 1. Vào Google Sheet → Extensions → Apps Script
 * 2. Xoá toàn bộ code cũ, paste code này vào
 * 3. Bấm "Deploy" → "New deployment"
 * 4. Type: "Web app"
 * 5. Execute as: "Me"
 * 6. Who has access: "Anyone"
 * 7. Bấm "Deploy" → Copy URL → Paste vào dat-phong.html (biến APPS_SCRIPT_URL)
 *
 * CẤU TRÚC SHEET THÁNG (ví dụ "4/2026"):
 * Cột A: Ngày (định dạng DD/MM/YYYY)
 * Cột B: Thứ
 * Cột C-E:  ÀLA1 (Vintage)     — C=ngày, D=giờ, E=đêm
 * Cột F-H:  ÀLA2 (Minimalist)  — F=ngày, G=giờ, H=đêm
 * Cột I-K:  ÀLA3 (Cozy)        — I=ngày, J=giờ, K=đêm
 * Cột L-N:  ÀLA4 (Tiny-1)      — L=ngày, M=giờ, N=đêm
 * Cột O-Q:  ÀLA5 (Tiny-2)      — O=ngày, P=giờ, Q=đêm
 * Dữ liệu bắt đầu từ hàng 6
 */

const NOTIFY_EMAIL  = 'alahome.saigon@gmail.com';
const DATA_START_ROW = 6;
const BOOKED_COLOR   = '#00FFFF';

// Cột base (1-indexed) cho từng phòng
const ROOM_BASE_COL = {
  'vintage':    3,   // C
  'minimalist': 6,   // F
  'cozy':       9,   // I
  'tiny-1':     12,  // L
  'tiny-2':     15,  // O
};
// Offset trong block 3 cột: ngày=0, giờ=1, đêm=2
const ROOM_IDS = ['vintage', 'minimalist', 'cozy', 'tiny-1', 'tiny-2'];

const ROOM_DISPLAY = {
  'vintage':    'Vintage Room (ÀLA1)',
  'minimalist': 'Minimalist Room (ÀLA2)',
  'cozy':       'Cozy Room (ÀLA3)',
  'tiny-1':     'Tiny Room 1 (ÀLA4)',
  'tiny-2':     'Tiny Room 2 (ÀLA5)',
};

// ─────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────
function doGet(e) {
  const action = e.parameter.action || '';
  let result;
  try {
    if (action === 'check') {
      result = checkAvailability(
        e.parameter.cin,
        e.parameter.cout,
        e.parameter.cint,
        e.parameter.coutt
      );
    } else {
      result = { ok: true, message: 'ÀlaHome API is running.' };
    }
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let result;
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.action === 'book') {
      result = createBooking(data);
    } else {
      result = { ok: false, error: 'Unknown action' };
    }
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────────────────────────
// Xác định loại booking từ cin/cout/cint
// ─────────────────────────────────────────────
function getBookingType(cin, cout, cint) {
  if (cin === cout) return 'gio';       // cùng ngày → đặt theo giờ
  if (cint === '14:00') return 'ngay';  // check-in 14h → ngày đêm
  if (cint === '21:00') return 'dem';   // check-in 21h → đêm
  return 'ngay'; // fallback
}

// ─────────────────────────────────────────────
// Lấy danh sách ngày trong khoảng [start, end)
// ─────────────────────────────────────────────
function getDateRange(cinStr, coutStr) {
  const dates = [];
  const start = parseDateStr(cinStr);
  const end   = parseDateStr(coutStr);
  const cur   = new Date(start);
  while (cur < end) {
    dates.push(toYMD(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// "YYYY-MM-DD" → Date
function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Date → "YYYY-MM-DD"
function toYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// "YYYY-MM-DD" → "DD/MM/YYYY"
function ymdToDmy(s) {
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

// ─────────────────────────────────────────────
// Lấy/tạo sheet tháng (tên: "M/YYYY")
// ─────────────────────────────────────────────
function getMonthSheet(ss, dateStr) {
  const d = parseDateStr(dateStr);
  const tabName = `${d.getMonth() + 1}/${d.getFullYear()}`;
  return ss.getSheetByName(tabName);
}

// ─────────────────────────────────────────────
// Tìm hàng trong sheet ứng với ngày dateStr
// ─────────────────────────────────────────────
function findRowForDate(sheet, dateStr) {
  const dmy = ymdToDmy(dateStr);
  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return -1;
  const colA = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, 1).getValues();
  for (let i = 0; i < colA.length; i++) {
    const cell = String(colA[i][0]);
    // Hỗ trợ cả "DD/MM/YYYY" và Date object từ Sheets
    if (cell === dmy || cell.startsWith(dmy)) {
      return DATA_START_ROW + i;
    }
    // Nếu Sheets lưu Date object, chuyển đổi
    if (colA[i][0] instanceof Date) {
      const cd = colA[i][0];
      const cStr = `${String(cd.getDate()).padStart(2,'0')}/${String(cd.getMonth()+1).padStart(2,'0')}/${cd.getFullYear()}`;
      if (cStr === dmy) return DATA_START_ROW + i;
    }
  }
  return -1;
}

// ─────────────────────────────────────────────
// Kiểm tra xung đột — đọc từ sheet tháng
// ─────────────────────────────────────────────
function checkAvailability(cin, cout, cint, coutt) {
  if (!cin || !cout || !cint) {
    return { ok: false, error: 'Thiếu thông tin ngày/giờ.' };
  }

  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const type = getBookingType(cin, cout, cint);
  const bookedRooms = new Set();

  for (const roomId of ROOM_IDS) {
    if (isRoomBlocked(ss, roomId, cin, cout, cint, coutt, type)) {
      bookedRooms.add(roomId);
    }
  }

  const available = ROOM_IDS.filter(r => !bookedRooms.has(r));
  return { ok: true, available };
}

function isRoomBlocked(ss, roomId, cin, cout, cint, coutt, type) {
  const base = ROOM_BASE_COL[roomId];

  if (type === 'ngay') {
    // Ngày đêm (14h→12h): chiếm cột ngày cho mỗi đêm trong [cin, cout)
    // Cũng xung đột với đêm cùng ngày nhận phòng (21h→12h giao với 14h→12h)
    const nights = getDateRange(cin, cout);
    for (const d of nights) {
      const sheet = getMonthSheet(ss, d);
      if (!sheet) continue;
      const row = findRowForDate(sheet, d);
      if (row < 0) continue;
      // Cột ngày
      const ngayCell = sheet.getRange(row, base).getValue();
      if (ngayCell && String(ngayCell).trim() !== '') return true;
      // Cột đêm (21h→12h giao với 14h→12h)
      if (d === cin) {
        const demCell = sheet.getRange(row, base + 2).getValue();
        if (demCell && String(demCell).trim() !== '') return true;
      }
    }
  } else if (type === 'dem') {
    // Đêm (21h→12h hôm sau): chiếm đêm ngày cin + ngày ngày cin (vì 14h→12h giao)
    const sheet = getMonthSheet(ss, cin);
    if (sheet) {
      const row = findRowForDate(sheet, cin);
      if (row >= 0) {
        const demCell = sheet.getRange(row, base + 2).getValue();
        if (demCell && String(demCell).trim() !== '') return true;
        const ngayCell = sheet.getRange(row, base).getValue();
        if (ngayCell && String(ngayCell).trim() !== '') return true;
      }
    }
  } else {
    // Giờ: kiểm tra xung đột thời gian trong cột giờ cùng ngày
    const sheet = getMonthSheet(ss, cin);
    if (!sheet) return false;
    const row = findRowForDate(sheet, cin);
    if (row < 0) return false;
    const gioCell = String(sheet.getRange(row, base + 1).getValue() || '');
    if (!gioCell.trim()) return false;
    // Parse "Name Xh-Yh | Name2 Xh-Yh"
    const slots = gioCell.split('|').map(s => s.trim());
    const newStart = timeToMin(cint);
    const newEnd   = timeToMin(coutt);
    for (const slot of slots) {
      const m = slot.match(/(\d+)h-(\d+)h/);
      if (!m) continue;
      const sStart = parseInt(m[1]) * 60;
      const sEnd   = parseInt(m[2]) * 60;
      if (newStart < sEnd && newEnd > sStart) return true;
    }
  }
  return false;
}

function timeToMin(t) {
  const [h, m] = (t || '00:00').split(':').map(Number);
  return h * 60 + (m || 0);
}

// ─────────────────────────────────────────────
// Tạo booking — ghi vào sheet tháng + email
// ─────────────────────────────────────────────
function createBooking(data) {
  const { roomId, cin, cout, cint, coutt, adults, babies, totalPrice,
          guestName, guestPhone, guestEmail, guestNote, bookingId,
          cccdBase64, cccdFileName, cccdMimeType } = data;

  if (!roomId || !cin || !cout || !cint || !guestName || !guestPhone) {
    return { ok: false, error: 'Thiếu thông tin bắt buộc.' };
  }

  const type = getBookingType(cin, cout, cint);

  // Kiểm tra xung đột lần cuối
  const check = checkAvailability(cin, cout, cint, coutt);
  if (!check.ok) return check;
  if (!check.available.includes(roomId)) {
    return { ok: false, error: 'Phòng vừa được đặt bởi người khác. Vui lòng chọn phòng khác hoặc đổi lịch.' };
  }

  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const base = ROOM_BASE_COL[roomId];
  const id   = bookingId || ('ALA-' + Date.now().toString(36).toUpperCase());

  if (type === 'ngay') {
    const nights = getDateRange(cin, cout);
    for (const d of nights) {
      const sheet = getMonthSheet(ss, d);
      if (!sheet) continue;
      const row = findRowForDate(sheet, d);
      if (row < 0) continue;
      writeCell(sheet, row, base, guestName);
    }
  } else if (type === 'dem') {
    const sheet = getMonthSheet(ss, cin);
    if (sheet) {
      const row = findRowForDate(sheet, cin);
      if (row >= 0) writeCell(sheet, row, base + 2, guestName);
    }
  } else {
    // Giờ: "Name Xh-Yh"
    const hIn  = parseInt(cint.split(':')[0]);
    const hOut = parseInt(coutt.split(':')[0]);
    const label = `${guestName} ${hIn}h-${hOut}h`;
    const sheet = getMonthSheet(ss, cin);
    if (sheet) {
      const row = findRowForDate(sheet, cin);
      if (row >= 0) {
        const gioCol = base + 1;
        const existing = String(sheet.getRange(row, gioCol).getValue() || '').trim();
        const newVal = existing ? `${existing} | ${label}` : label;
        writeCell(sheet, row, gioCol, newVal);
      }
    }
  }

  // Gửi email thông báo
  sendNotificationEmail({
    id, roomId, roomDisplay: ROOM_DISPLAY[roomId] || roomId,
    cin, cout, cint, coutt, type, adults, babies, totalPrice,
    guestName, guestPhone, guestEmail, guestNote,
    cccdBase64, cccdFileName, cccdMimeType,
  });

  return { ok: true, bookingId: id };
}

// Ghi giá trị + tô màu cyan + bold
function writeCell(sheet, row, col, value) {
  const cell = sheet.getRange(row, col);
  cell.setValue(value);
  cell.setBackground(BOOKED_COLOR);
  cell.setFontWeight('bold');
}

// ─────────────────────────────────────────────
// Gửi email thông báo đặt phòng
// ─────────────────────────────────────────────
function sendNotificationEmail(info) {
  const typeLabel = info.type === 'ngay' ? 'Ngày đêm (14:00 → 12:00)'
                  : info.type === 'dem'  ? 'Đêm (21:00 → 12:00)'
                  : 'Theo giờ';

  const cinFmt  = ymdToDmy(info.cin);
  const coutFmt = ymdToDmy(info.cout);

  const timeRange = info.type === 'gio'
    ? `${info.cint} → ${info.coutt} ngày ${cinFmt}`
    : `${info.cint} ngày ${cinFmt} → ${info.coutt} ngày ${coutFmt}`;

  const subject = `[ÀlaHome] Đặt phòng mới — ${info.guestName} — ${info.roomDisplay}`;

  const html = `
<!DOCTYPE html>
<html lang="vi">
<head><meta charset="UTF-8" /></head>
<body style="margin:0;padding:0;background:#F8F5F0;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8F5F0;padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:#4A6741;padding:28px 32px;">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">ÀlaHome</h1>
            <p style="margin:4px 0 0;color:#C4A882;font-size:12px;letter-spacing:2px;text-transform:uppercase;">Booking Notification</p>
          </td>
        </tr>

        <!-- Title -->
        <tr>
          <td style="padding:28px 32px 0;">
            <h2 style="margin:0;color:#1A1A1A;font-size:18px;">Đặt phòng mới vừa được tạo</h2>
            <p style="margin:6px 0 0;color:#6B6560;font-size:14px;">Mã booking: <strong style="color:#4A6741;">${info.id}</strong></p>
          </td>
        </tr>

        <!-- Booking details -->
        <tr>
          <td style="padding:20px 32px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E2DDD7;border-radius:8px;overflow:hidden;">
              <tr style="background:#EBF2E8;">
                <td colspan="2" style="padding:12px 16px;font-weight:700;color:#4A6741;font-size:13px;text-transform:uppercase;letter-spacing:1px;">Thông tin đặt phòng</td>
              </tr>
              ${row2('Mã booking',  info.id)}
              ${row2('Phòng',       info.roomDisplay)}
              ${row2('Loại',        typeLabel)}
              ${row2('Thời gian',   timeRange)}
              ${row2('Người lớn',   info.adults + ' người')}
              ${row2('Em bé',       info.babies + ' em bé')}
              ${row2('Tổng tiền',   formatVND(info.totalPrice))}
            </table>
          </td>
        </tr>

        <!-- Guest info -->
        <tr>
          <td style="padding:16px 32px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E2DDD7;border-radius:8px;overflow:hidden;">
              <tr style="background:#EBF2E8;">
                <td colspan="2" style="padding:12px 16px;font-weight:700;color:#4A6741;font-size:13px;text-transform:uppercase;letter-spacing:1px;">Thông tin khách hàng</td>
              </tr>
              ${row2('Họ và tên',       info.guestName)}
              ${row2('Số điện thoại',   info.guestPhone)}
              ${row2('Email',           info.guestEmail || '—')}
              ${info.guestNote ? row2('Ghi chú', info.guestNote) : ''}
            </table>
          </td>
        </tr>

        <!-- Status notice -->
        <tr>
          <td style="padding:20px 32px;">
            <table width="100%" cellpadding="12" cellspacing="0" style="background:#FFF8E7;border:1px solid #F5DFA0;border-radius:8px;">
              <tr>
                <td style="color:#856404;font-size:14px;">
                  ⏳ Trạng thái: <strong>Chờ xác nhận thanh toán</strong><br/>
                  <span style="font-size:13px;color:#6B6560;">Vui lòng kiểm tra chuyển khoản và xác nhận booking trong Google Sheet.</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:16px 32px 28px;border-top:1px solid #E2DDD7;">
            <p style="margin:0;color:#6B6560;font-size:12px;">© 2025 ÀlaHome · 370 Điện Biên Phủ, Phường Vườn Lài, TP. Hồ Chí Minh</p>
            <p style="margin:4px 0 0;color:#6B6560;font-size:12px;">ĐT/Zalo: 0911 297 249 · alahome.saigon@gmail.com</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    const mailOptions = {
      to:       NOTIFY_EMAIL,
      subject:  subject,
      htmlBody: html,
    };

    // Đính kèm ảnh CCCD nếu có
    if (info.cccdBase64 && info.cccdFileName) {
      const mimeType = info.cccdMimeType || 'image/jpeg';
      const blob = Utilities.newBlob(
        Utilities.base64Decode(info.cccdBase64),
        mimeType,
        info.cccdFileName
      );
      mailOptions.attachments = [blob];
    }

    MailApp.sendEmail(mailOptions);
  } catch (e) {
    Logger.log('Email error: ' + e.message);
  }
}

function row2(label, value) {
  return `<tr style="border-top:1px solid #E2DDD7;">
    <td style="padding:10px 16px;color:#6B6560;font-size:14px;width:40%;">${label}</td>
    <td style="padding:10px 16px;color:#1A1A1A;font-size:14px;font-weight:500;">${value}</td>
  </tr>`;
}

function formatVND(amount) {
  const n = parseInt(amount) || 0;
  return n.toLocaleString('vi-VN') + 'đ';
}
