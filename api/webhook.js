import TelegramBot from "node-telegram-bot-api";
import { supabase } from "../supabaseClient.js";

const bot = new TelegramBot(process.env.BOT_TOKEN);
const userState = {}; // state sementara per user

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const { message, callback_query } = req.body;

  try {
    // =========================================
    // === HANDLE PESAN DARI USER (message) ===
    // =========================================
    if (message) {
      const chatId = message.chat.id;

      // --- /start ---
      if (message.text === "/start") {
        await bot.sendMessage(
          chatId,
          `👋 Selamat datang di *Bot Pelaporan Survey Lapangan!*\n\n📋 Cara penggunaan:\n1️⃣ Ketik /lapor untuk mulai.\n2️⃣ Pilih segmentasi & designator.\n3️⃣ Kirim foto eviden, lokasi, dan keterangan.\n\nData akan otomatis tersimpan ke sistem.`,
          { parse_mode: "Markdown" }
        );
      }

      // --- /lapor ---
      else if (message.text === "/lapor") {
        const { data: segList, error } = await supabase
          .from("segmentasi")
          .select("id, nama_segmentasi");

        if (error || !segList?.length)
          return bot.sendMessage(chatId, "❌ Gagal ambil data segmentasi.");

        const buttons = segList.map((s) => [
          { text: s.nama_segmentasi, callback_data: `seg_${s.nama_segmentasi}` },
        ]);

        await bot.sendMessage(chatId, "Pilih segmentasi:", {
          reply_markup: { inline_keyboard: buttons },
        });
      }

      // --- kirim foto ---
      else if (message.photo) {
        const fileId = message.photo[message.photo.length - 1].file_id;
        const file = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

        // Pastikan state user ada
        if (!userState[chatId]) userState[chatId] = {};

        const folder = userState[chatId].folder_path || "umum";
        const fileName = `eviden_${Date.now()}.jpg`;

        // Ambil file buffer
        const response = await fetch(fileUrl);
        const buffer = Buffer.from(await response.arrayBuffer());

        // Upload ke Supabase Storage
        const { error: uploadError } = await supabase.storage
          .from("evidence")
          .upload(`${folder}/${fileName}`, buffer, {
            contentType: "image/jpeg",
            upsert: false,
          });

        if (uploadError) {
          console.error(uploadError);
          return bot.sendMessage(chatId, "❌ Gagal upload foto ke storage Supabase.");
        }

        // Ambil URL publik
        const { data: publicUrlData } = supabase.storage
          .from("evidence")
          .getPublicUrl(`${folder}/${fileName}`);

        if (!userState[chatId].foto_urls) userState[chatId].foto_urls = [];
        userState[chatId].foto_urls.push(publicUrlData.publicUrl);

        await bot.sendMessage(
          chatId,
          "📸 Foto berhasil diunggah. Kirim foto lain jika ada, atau ketik *selesai* bila sudah cukup.",
          { parse_mode: "Markdown" }
        );
      }

      // --- setelah selesai upload foto ---
      else if (
        message.text?.toLowerCase() === "selesai" &&
        userState[chatId]?.foto_urls?.length
      ) {
        await bot.sendMessage(
          chatId,
          "📍 Sekarang kirim *lokasi* Anda (gunakan fitur share location).",
          { parse_mode: "Markdown" }
        );
      }

      // --- kirim lokasi ---
      else if (message.location) {
        if (!userState[chatId]) userState[chatId] = {};
        const { latitude, longitude } = message.location;
        userState[chatId].lokasi = `${latitude},${longitude}`;

        await bot.sendMessage(chatId, "✏️ Terakhir, kirim keterangan tambahan:");
      }

      // --- kirim keterangan ---
      else if (
        message.text &&
        !message.text.startsWith("/") &&
        userState[chatId]?.designator
      ) {
        const data = userState[chatId];
        data.keterangan = message.text;

        const summary = `
🧾 *Konfirmasi Laporan Anda:*

📍 Segmentasi: *${data.segmentasi}*
🔧 Designator: *${data.designator}*
🗺️ Lokasi: ${data.lokasi}
📝 Keterangan: ${data.keterangan}
📷 Jumlah Foto: ${data.foto_urls?.length || 0}

Apakah Anda ingin mengirim laporan ini?
`;

        await bot.sendMessage(chatId, summary, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Kirim", callback_data: "konfirmasi_kirim" },
                { text: "❌ Batal", callback_data: "konfirmasi_batal" },
              ],
            ],
          },
        });
      }
    }

    // =========================================
    // === HANDLE CALLBACK (inline keyboard) ===
    // =========================================
    if (callback_query) {
      const chatId = callback_query.message.chat.id;

      // --- pilih segmentasi ---
      if (callback_query.data.startsWith("seg_")) {
        const segName = callback_query.data.replace("seg_", "");
        if (!userState[chatId]) userState[chatId] = {};
        userState[chatId].segmentasi = segName;

        const { data: designators, error } = await supabase
          .from("designator")
          .select("Designator");

        if (error || !designators?.length)
          return bot.sendMessage(chatId, "❌ Gagal mengambil data designator.");

        const buttons = designators.map((d) => [
          { text: d.Designator, callback_data: `des_${encodeURIComponent(d.Designator)}` },
        ]);

        await bot.sendMessage(
          chatId,
          `📍 Segmentasi *${segName}* dipilih.\nSekarang pilih designator:`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }
        );
      }

      // --- pilih designator ---
      else if (callback_query.data.startsWith("des_")) {
        const designator = decodeURIComponent(callback_query.data.replace("des_", ""));
        if (!userState[chatId]) userState[chatId] = {};
        userState[chatId].designator = designator;
        userState[chatId].folder_path = `${userState[chatId].segmentasi}/${designator}`;

        await bot.sendMessage(chatId, "📸 Silakan kirim foto eviden pekerjaan.");
      }

      // --- konfirmasi kirim ---
      else if (callback_query.data === "konfirmasi_kirim") {
        const data = userState[chatId];
        const userId = callback_query.from.id;

        if (!data) {
          return bot.sendMessage(chatId, "⚠️ Tidak ada data laporan yang siap dikirim.");
        }

        const { error } = await supabase.from("data_survey").insert([
          {
            telegram_user_id: userId,
            segmentasi: data.segmentasi,
            designator: data.designator,
            folder_path: data.folder_path,
            foto_url: data.foto_urls.join(", "),
            lokasi: data.lokasi,
            keterangan: data.keterangan,
          },
        ]);

        if (error) {
          console.error(error);
          await bot.sendMessage(chatId, "❌ Gagal menyimpan data ke server.");
        } else {
          await bot.sendMessage(chatId, "✅ Laporan berhasil dikirim! Terima kasih 🙏");
        }

        delete userState[chatId];
      }

      // --- konfirmasi batal ---
      else if (callback_query.data === "konfirmasi_batal") {
        delete userState[chatId];
        await bot.sendMessage(chatId, "❌ Laporan dibatalkan.");
      }
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ ERROR HANDLER:", err);
    res.status(500).send("Internal Server Error");
  }
}
