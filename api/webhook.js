import TelegramBot from "node-telegram-bot-api";
import { supabase } from "../supabaseClient.js";

const bot = new TelegramBot(process.env.BOT_TOKEN);
const userState = {}; // state sementara per user

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const { message, callback_query } = req.body;

  // --- /start ---
  if (message?.text === "/start") {
    await bot.sendMessage(
      message.chat.id,
      `👋 Selamat datang di *Bot Pelaporan Survey Lapangan!*\n\n📋 Cara penggunaan:\n1️⃣ Ketik /lapor untuk mulai.\n2️⃣ Pilih segmentasi & designator.\n3️⃣ Kirim foto eviden, lokasi, dan keterangan.\n\nData akan otomatis tersimpan ke sistem.`,
      { parse_mode: "Markdown" }
    );
  }

  // --- /lapor ---
  else if (message?.text === "/lapor") {
    const { data: segList, error } = await supabase
      .from("segmentasi")
      .select("id, nama_segmentasi");

    if (error || !segList?.length)
      return bot.sendMessage(message.chat.id, "❌ Gagal ambil data segmentasi.");

    const buttons = segList.map((s) => [
      { text: s.nama_segmentasi, callback_data: `seg_${s.nama_segmentasi}` },
    ]);

    await bot.sendMessage(message.chat.id, "Pilih segmentasi:", {
      reply_markup: { inline_keyboard: buttons },
    });
  }

  // --- pilih segmentasi ---
  else if (callback_query?.data.startsWith("seg_")) {
    const chatId = callback_query.message.chat.id;
    const segName = callback_query.data.replace("seg_", "");
    userState[chatId] = { segmentasi: segName };

    // Ambil semua designator
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
  else if (callback_query?.data.startsWith("des_")) {
    const chatId = callback_query.message.chat.id;
    const designator = decodeURIComponent(callback_query.data.replace("des_", ""));
    userState[chatId].designator = designator;

    // Buat folder path otomatis
    userState[chatId].folder_path = `${userState[chatId].segmentasi}/${designator}`;

    await bot.sendMessage(chatId, "📸 Silakan kirim foto eviden pekerjaan.");
  }

// --- kirim foto (bisa lebih dari satu) ---
else if (message?.photo) {
  const chatId = message.chat.id;
  const fileId = message.photo[message.photo.length - 1].file_id;
  const file = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

  if (!userState[chatId]) userState[chatId] = {};
  if (!userState[chatId].foto_urls) userState[chatId].foto_urls = [];

  userState[chatId].foto_urls.push(fileUrl);

  await bot.sendMessage(
    chatId,
    "📸 Foto tersimpan. Kirim foto lain jika ada, atau ketik *selesai* bila sudah cukup.",
    { parse_mode: "Markdown" }
  );
}
  // --- kirim foto (upload ke Supabase Storage "evidence") ---
  else if (message?.photo) {
    const chatId = message.chat.id;
    const fileId = message.photo[message.photo.length - 1].file_id;

// --- setelah semua foto selesai, user ketik 'selesai' ---
else if (
  message?.text?.toLowerCase() === "selesai" &&
  userState[message.chat.id]?.foto_urls?.length
) {
  const chatId = message.chat.id;

  await bot.sendMessage(
    chatId,
    "📍 Sekarang kirim *lokasi* Anda (gunakan fitur share location).",
    { parse_mode: "Markdown" }
  );
}
    // Ambil file URL dari Telegram
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

    // Unduh file dari Telegram
    const response = await fetch(fileUrl);
    const buffer = await response.arrayBuffer();

    // Pastikan ada folder path
    if (!userState[chatId]) userState[chatId] = {};
    const folder = userState[chatId].folder_path || "umum";
    const fileName = `eviden_${Date.now()}.jpg`;

    // Upload ke Supabase Storage bucket "evidence"
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

    // Ambil public URL dari file yang baru diupload
    const { data: publicUrlData } = supabase.storage
      .from("evidence")
      .getPublicUrl(`${folder}/${fileName}`);

    // Simpan ke state
    if (!userState[chatId].foto_urls) userState[chatId].foto_urls = [];
    userState[chatId].foto_urls.push(publicUrlData.publicUrl);

    await bot.sendMessage(
      chatId,
      "📸 Foto berhasil diunggah ke server. Kirim foto lain jika ada, atau ketik *selesai* bila sudah cukup.",
      { parse_mode: "Markdown" }
    );
  }

  // --- setelah semua foto selesai, user ketik 'selesai' ---
  else if (
    message?.text?.toLowerCase() === "selesai" &&
    userState[message.chat.id]?.foto_urls?.length
  ) {
    const chatId = message.chat.id;

    await bot.sendMessage(
      chatId,
      "📍 Sekarang kirim *lokasi* Anda (gunakan fitur share location).",
      { parse_mode: "Markdown" }
    );
  }

  // --- kirim lokasi ---
  else if (message?.location) {
    const chatId = message.chat.id;
    const { latitude, longitude } = message.location;

    if (!userState[chatId]) userState[chatId] = {};
    userState[chatId].lokasi = `${latitude},${longitude}`;

    await bot.sendMessage(chatId, "✏️ Terakhir, kirim keterangan tambahan:");
  }

// --- kirim keterangan ---
else if (
  message?.text &&
  !message.text.startsWith("/") &&
  userState[message.chat.id]?.designator
) {
  const chatId = message.chat.id;
  const data = userState[chatId];
  data.keterangan = message.text;

  // Ringkasan laporan
const summary = `
  // --- kirim keterangan ---
  else if (
    message?.text &&
    !message.text.startsWith("/") &&
    userState[message.chat.id]?.designator
  ) {
    const chatId = message.chat.id;
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
    await bot.sendMessage(chatId, summary, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Kirim", callback_data: "konfirmasi_kirim" },
            { text: "❌ Batal", callback_data: "konfirmasi_batal" },
          ],
        ],
      ],
    },
  });
}
// --- konfirmasi kirim ---
else if (callback_query?.data === "konfirmasi_kirim") {
  const chatId = callback_query.message.chat.id;
  const userId = callback_query.from.id;
  const data = userState[chatId];

  if (!data) {
    return bot.sendMessage(chatId, "⚠️ Tidak ada data laporan yang siap dikirim.");
      },
    });
  }

const { error } = await supabase.from("data_survey").insert([
  {
    telegram_user_id: userId,
    segmentasi: data.segmentasi,
    designator: data.designator,
    folder_path: `${data.segmentasi}/${data.designator}`,
    foto_url: data.foto_urls.join(", "),
    lokasi: data.lokasi, // ganti baris ini
    keterangan: data.keterangan,
  },
]);

  if (error) {
    console.error(error);
    await bot.sendMessage(chatId, "❌ Gagal menyimpan data ke server.");
  } else {
    await bot.sendMessage(chatId, "✅ Laporan berhasil dikirim! Terima kasih 🙏");
  }
  // --- konfirmasi kirim ---
  else if (callback_query?.data === "konfirmasi_kirim") {
    const chatId = callback_query.message.chat.id;
    const userId = callback_query.from.id;
    const data = userState[chatId];

  delete userState[chatId];
}
    if (!data) {
      return bot.sendMessage(chatId, "⚠️ Tidak ada data laporan yang siap dikirim.");
    }

    // Simpan ke Supabase
    const { error } = await supabase.from("data_survey").insert([
      {
        telegram_user_id: userId,
        segmentasi: data.segmentasi,
        designator: data.designator,
        folder_path: `${data.segmentasi}/${data.designator}`,
        foto_url: data.foto_urls.join(", "),
        lokasi: data.lokasi,
        keterangan: data.keterangan,
      },
    ]);

// --- konfirmasi batal ---
else if (callback_query?.data === "konfirmasi_batal") {
  const chatId = callback_query.message.chat.id;
  delete userState[chatId];
  await bot.sendMessage(chatId, "❌ Laporan dibatalkan.");
    if (error) {
      console.error(error);
      await bot.sendMessage(chatId, "❌ Gagal menyimpan data ke server.");
    } else {
      await bot.sendMessage(chatId, "✅ Laporan berhasil dikirim! Terima kasih 🙏");
    }

    delete userState[chatId];
  }

  // --- konfirmasi batal ---
  else if (callback_query?.data === "konfirmasi_batal") {
    const chatId = callback_query.message.chat.id;
    delete userState[chatId];
    await bot.sendMessage(chatId, "❌ Laporan dibatalkan.");
  }

  res.status(200).send("OK");
}
