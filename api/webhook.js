import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "PASTE_TOKENMU_DI_SINI";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const userState = {};

async function sendMessage(chatId, text, options = {}) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...options }),
  });
}

// ---- Handler utama ----
app.post("/api/webhook", async (req, res) => {
  const body = req.body;
  console.log("Update:", JSON.stringify(body, null, 2));

  try {
    // ====== Pesan utama ======
    if (body.message) {
      const msg = body.message;
      const chatId = msg.chat.id;

      // /start
      if (msg.text === "/start") {
        await sendMessage(
          chatId,
          "👋 Selamat datang di Bot Laporan Survey!\n\nGunakan /lapor untuk mengirim laporan baru.\n\nLangkah:\n1️⃣ Pilih segmentasi\n2️⃣ Pilih designator\n3️⃣ Kirim foto eviden\n4️⃣ Share lokasi\n5️⃣ Tulis keterangan\n6️⃣ Konfirmasi simpan"
        );
      }

      // /lapor
      else if (msg.text === "/lapor") {
        userState[chatId] = {};
        const { data: segmentasi } = await supabase.from("segmentasi").select("segmentasi");

        if (!segmentasi?.length) {
          await sendMessage(chatId, "Belum ada data segmentasi di Supabase.");
          return res.send("ok");
        }

        const buttons = segmentasi.map((s) => [
          { text: s.segmentasi, callback_data: `seg_${s.segmentasi}` },
        ]);

        await sendMessage(chatId, "Pilih segmentasi:", {
          reply_markup: { inline_keyboard: buttons },
        });
      }

      // terima foto
      else if (msg.photo && userState[chatId]?.waitingFor === "foto") {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const fileInfo = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`).then((r) =>
          r.json()
        );
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.result.file_path}`;
        userState[chatId].photos.push(fileUrl);
        await sendMessage(chatId, "📸 Foto diterima! Kirim lagi jika ingin menambah, atau kirim lokasi sekarang.");
      }

      // terima lokasi
      else if (msg.location && userState[chatId]?.waitingFor === "foto") {
        userState[chatId].lokasi = `${msg.location.latitude},${msg.location.longitude}`;
        userState[chatId].waitingFor = "keterangan";
        await sendMessage(chatId, "📝 Silakan kirim keterangan laporan:");
      }

      // terima keterangan
      else if (userState[chatId]?.waitingFor === "keterangan") {
        userState[chatId].keterangan = msg.text;

        await sendMessage(chatId, "Apakah semua data sudah benar dan siap disimpan?", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Ya, simpan", callback_data: "confirm_yes" }],
              [{ text: "❌ Ulangi", callback_data: "confirm_no" }],
            ],
          },
        });
      }
    }

    // ====== Callback Query ======
    else if (body.callback_query) {
      const cb = body.callback_query;
      const chatId = cb.message.chat.id;

      // pilih segmentasi
      if (cb.data.startsWith("seg_")) {
        const segmentasi = cb.data.replace("seg_", "");
        userState[chatId] = { segmentasi };

        const { data: designators } = await supabase.from("designator").select("Designator");

        if (!designators?.length) {
          await sendMessage(chatId, "Belum ada designator di Supabase.");
          return res.send("ok");
        }

        const buttons = designators.map((d) => [
          { text: d.Designator, callback_data: `des_${d.Designator}` },
        ]);

        await sendMessage(chatId, "Pilih designator:", {
          reply_markup: { inline_keyboard: buttons },
        });
      }

      // pilih designator
      else if (cb.data.startsWith("des_")) {
        const designator = cb.data.replace("des_", "");
        userState[chatId].designator = designator;
        userState[chatId].photos = [];
        userState[chatId].waitingFor = "foto";

        await sendMessage(
          chatId,
          `📷 Silakan kirim foto eviden untuk:\nSegmentasi: ${userState[chatId].segmentasi}\nDesignator: ${designator}\n\nKamu bisa kirim lebih dari satu foto. Jika sudah selesai, kirim lokasi (share location).`
        );
      }

      // konfirmasi simpan
      else if (cb.data === "confirm_yes") {
        const d = userState[chatId];
        if (!d) {
          await sendMessage(chatId, "Data tidak ditemukan, silakan ulangi /lapor");
          return;
        }

        const fotoUrls = [];
        for (let i = 0; i < d.photos.length; i++) {
          const foto = await fetch(d.photos[i]);
          const buffer = Buffer.from(await foto.arrayBuffer());
          const fileName = `${Date.now()}_${i}.jpg`;
          const path = `${d.segmentasi}/${d.designator}/${fileName}`;

          const { error: uploadError } = await supabase.storage
            .from("evidence")
            .upload(path, buffer, { contentType: "image/jpeg" });

          if (uploadError) console.error(uploadError);
          else {
            const { data: publicUrl } = supabase.storage
              .from("evidence")
              .getPublicUrl(path);
            fotoUrls.push(publicUrl.publicUrl);
          }
        }

        const { error } = await supabase.from("data_survey").insert([
          {
            segmentasi: d.segmentasi,
            designator: d.designator,
            foto_url: fotoUrls.join(", "),
            lokasi: d.lokasi,
            keterangan: d.keterangan,
            telegram_user_id: chatId,
            created_at: new Date(),
          },
        ]);

        if (error) {
          console.error(error);
          await sendMessage(chatId, "❌ Gagal menyimpan data ke Supabase.");
        } else {
          await sendMessage(chatId, "✅ Laporan berhasil disimpan! Terima kasih 🙏");
        }

        delete userState[chatId];
      }

      // konfirmasi ulang
      else if (cb.data === "confirm_no") {
        delete userState[chatId];
        await sendMessage(chatId, "Baik, silakan ulangi laporan dengan /lapor");
      }
    }

    res.send("ok");
  } catch (err) {
    console.error("Error:", err);
    res.status(500).send("Error processing update");
  }
});

app.listen(3000, () => console.log("Bot webhook aktif di port 3000"));
