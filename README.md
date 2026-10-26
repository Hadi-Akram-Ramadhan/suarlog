# Suarlog AI - Chrome Extension (Manifest V3)

Ekstensi Chrome cerdas untuk monitoring live meeting (Google Meet, Zoom Web, Microsoft Teams), menangkap transkrip otomatis secara real-time, pratinjau dan riwayat tangkapan layar slide, analisis AI mendalam, serta integrasi langsung ke Bot Telegram pribadi Anda.

---

## Fitur Utama

1. **Live Caption & Transkrip Real-Time:**
   - Mendeteksi teks percakapan dan closed captions secara langsung dari elemen Web meeting.
   - Menyimpan seluruh log verbatim secara urut waktu.

2. **Daftar Tangkapan Layar (Gallery):**
   - Menangkap layar tab meeting (`captureVisibleTab`) secara berkala atau instan saat ada pergantian materi.
   - Galeri thumbnail dengan timestamp untuk setiap slide yang dipresentasikan.

3. **Sinkronisasi Telegram Bot:**
   - Notifikasi mulai, update slide berkala, transkrip, dan analisis meeting terkirim otomatis ke Chat ID Telegram Anda.
   - Mendukung kirim foto slide beserta teks penjelasan lengkap.
   - Tombol uji coba koneksi bot Telegram langsung dari tab Pengaturan.

4. **Kustomisasi Penuh Endpoint AI & Model:**
   - Mendukung endpoint kustom (OpenAI kompatibel, seperti `http://localhost:20128/v1` 9Router, OpenAI, Groq, OpenRouter).
   - Pengaturan API Key dan pilihan Model AI (misalnya `ag/gemini-3.8-flash-high`, `openai/gpt-4o`, dll).

5. **Mode Analisis Fleksibel:**
   - **Sangat Detail:** Transkrip verbatim lengkap, bedah poin teknis, dan action items.
   - **Ringkas Padat:** Poin esensial dan keputusan akhir.
   - **Struktur Kuliah/Bootcamp:** Rangkuman materi per topik, Q&A, dan referensi.

---

## Cara Pasang (Load Unpacked di Chrome)

1. Buka browser Google Chrome Anda.
2. Masuk ke halaman ekstensi dengan mengetikkan: `chrome://extensions/` di address bar.
3. Aktifkan **Developer mode** (Mode Pengembang) di pojok kanan atas layar.
4. Klik tombol **Load unpacked** (Muat yang belum dibongkar) di pojok kiri atas.
5. Pilih folder:
   ```text
   C:\Users\kkhad\Desktop\meet-pulse-extension
   ```
6. Ekstensi **Suarlog AI** akan langsung aktif dan muncul di daftar ekstensi Chrome Anda.

---

## Cara Penggunaan

1. Buka tab meeting online Anda (Google Meet, Zoom Web, atau Teams).
2. Klik ikon **Suarlog AI** di toolbar Chrome Anda.
3. Buka tab **Pengaturan**:
   - Masukkan Bot Token Telegram Anda (dari @BotFather).
   - Masukkan Chat ID Telegram Anda (dari @userinfobot).
   - Atur Base URL (default: `http://localhost:20128/v1`) dan API Key jika diperlukan.
   - Klik **Simpan Pengaturan**, lalu klik **Kirim Tes Notifikasi Telegram** untuk memastikan koneksi aktif.
4. Kembali ke tab **Monitor**, klik **Mulai Monitor Meeting**.
5. Biarkan tab meeting berjalan. Setiap ada slide dan transkrip, data akan masuk ke ekstensi dan terkirim ke Telegram Anda.
6. Kapan saja Anda ingin merangkum meeting secara menyeluruh, klik tombol **Analisis Keseluruhan Meeting**.
