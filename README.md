# LINE Rich Menu Switcher — TOP TEST 3

ระบบ Backend + หน้า Admin สำหรับสร้าง Rich Menu แบบสลับแท็บ (เหมือน HomePro: แถบ "โปรโมชั่น" / "เมนู") โดยไม่ต้องเขียนโค้ดเพิ่ม

**จุดเด่น: ไม่มี dependency เลย (pure Node.js) — ไม่ต้อง `npm install`**

## ความสามารถ

- ใส่รูป Rich Menu ของแถบ 1 / แถบ 2 ได้เอง (ระบบย่อ/ครอปเป็น 2500×1686 และบีบอัดต่ำกว่า 1MB ให้อัตโนมัติ)
- เลือก template ปุ่มสำเร็จรูป (แท็บ + 6/4/3/2/1 ปุ่ม) หรือโหมด **วาดเอง** ลากกรอบปุ่มบนรูปได้อิสระ
- ปุ่มแต่ละอันตั้งค่าได้: สลับแท็บ / เปิดลิงก์ / ส่งข้อความ
- หน้า Config เชื่อมต่อ LINE Channel (ใส่ Channel Access Token) + ปุ่มทดสอบการเชื่อมต่อ
- กด "เผยแพร่" ครั้งเดียว ระบบจัดการให้ทั้งหมด: สร้าง rich menu 2 อัน → อัปโหลดรูป → สร้าง alias → ตั้งแถบ 1 เป็นเมนูเริ่มต้น → ลบเมนูเก่า
- การสลับแท็บใช้ action `richmenuswitch` ของ LINE — **ไม่ต้องตั้ง webhook**

---

## 1) เอา Channel Access Token จาก LINE Developers (ทำครั้งเดียว)

1. เข้า https://developers.line.biz/console/ → เลือก Provider → Channel ของ **TOP TEST 3** (Messaging API channel)
   - ถ้ายังไม่มี Messaging API channel: เข้า https://manager.line.biz → เลือก OA "TOP TEST 3" → Settings → Messaging API → Enable แล้วผูกกับ Provider
2. ไปที่แท็บ **Messaging API** เลื่อนลงล่างสุด → **Channel access token (long-lived)** → กด **Issue**
3. คัดลอก token เก็บไว้ (จะเอาไปวางในหน้า Admin ขั้นตอนที่ 1)

## 2) Deploy บน Render.com (ฟรี)

1. สร้าง GitHub repo ใหม่ แล้ว push โฟลเดอร์นี้ขึ้นไป:
   ```bash
   cd line-richmenu-switcher
   git init && git add . && git commit -m "init"
   git remote add origin https://github.com/<your-username>/line-richmenu-switcher.git
   git push -u origin main
   ```
2. เข้า https://render.com → **New +** → **Web Service** → เชื่อม GitHub repo นี้
3. Render จะอ่าน `render.yaml` ให้อัตโนมัติ (Runtime: Node, Start: `npm start`, Plan: Free)
4. (แนะนำ) ตั้ง Environment Variables ใน Render Dashboard:
   | Key | Value | หมายเหตุ |
   |---|---|---|
   | `CHANNEL_ACCESS_TOKEN` | token จากข้อ 1 | ตั้งไว้ที่นี่จะไม่หายตอน server restart |
   | `ADMIN_PASSWORD` | รหัสผ่านที่ต้องการ | ป้องกันหน้า admin (username ใส่อะไรก็ได้) |
5. กด Deploy → ได้ URL เช่น `https://line-richmenu-switcher.onrender.com` → เปิดหน้า admin ได้เลย

> ⚠️ Render free tier: ไฟล์ที่อัปโหลด (รูป/การตั้งค่า) จะหายเมื่อ server restart/redeploy — token ให้ใส่ผ่าน env var ตามข้อ 4 ส่วนรูปถ้าหายให้อัปโหลดใหม่แล้วกดเผยแพร่ซ้ำ (rich menu ที่เผยแพร่ไปแล้วบน LINE **ไม่หาย**)

## 3) รันบนเครื่องตัวเอง (ทางเลือก)

```bash
cd line-richmenu-switcher
node server.js
# เปิด http://localhost:3000
```
ต้องมี Node.js 18 ขึ้นไป — ไม่ต้อง npm install

## 4) วิธีใช้งานหน้า Admin

1. **ขั้นตอนที่ 1** — วาง Channel Access Token → บันทึก → กด "ทดสอบการเชื่อมต่อ" (ต้องขึ้นชื่อ bot "TOP TEST 3")
2. **ขั้นตอนที่ 2** — ทำทีละแถบ (แถบ 1 / แถบ 2):
   - อัปโหลดรูป (แนะนำออกแบบที่ 2500×1686 โดยเผื่อพื้นที่แถบ tab ด้านบนสูง ~253px)
   - เลือก template ปุ่ม หรือเลือก "วาดเอง" แล้วลากกรอบบนรูป
   - คลิกปุ่มแต่ละอันบนรูปเพื่อตั้ง action (สลับแท็บ / เปิดลิงก์ / ส่งข้อความ)
   - แต่ละแถบต้องมีปุ่ม "สลับแท็บ" อย่างน้อย 1 ปุ่ม
3. **ขั้นตอนที่ 3** — กด 🚀 เผยแพร่ → เปิดแชท LINE ของ TOP TEST 3 แล้วลองกดสลับแท็บได้ทันที

## โครงสร้างการทำงาน (Technical)

```
publish:
  POST /v2/bot/richmenu                (สร้างเมนูแถบ 1, แถบ 2)
  POST api-data /richmenu/{id}/content (อัปโหลดรูป JPEG)
  POST /v2/bot/richmenu/alias          (alias: switcher-tab-1, switcher-tab-2)
  POST /v2/bot/user/all/richmenu/{id}  (ตั้งแถบ 1 เป็น default)
ปุ่มสลับแท็บ = action {type: "richmenuswitch", richMenuAliasId, data}
```

| ไฟล์ | หน้าที่ |
|---|---|
| `server.js` | Backend ทั้งหมด (pure Node.js, ไม่มี dependency) |
| `public/index.html` | หน้า Admin UI |
| `render.yaml` | Config สำหรับ deploy Render.com |
| `data/` | เก็บการตั้งค่า + รูปที่อัปโหลด (สร้างอัตโนมัติ) |
