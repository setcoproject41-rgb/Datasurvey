import TelegramBot from "node-telegram-bot-api";
import { supabase } from "../supabaseClient.js";

const bot = new TelegramBot(process.env.BOT_TOKEN);

// Simpan state sementara per user
const userState = {};

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

    if (error) return bot.sendMessage(message.chat.id, "❌ Gagal ambil data segmentasi.");

    const buttons = segList.map((s) => [
      { text: s.nama_segmentasi, callback_data: `seg_${s.id}` },
    ]);

    await bot.sendMessage(message.chat.id, "Pilih segmentasi:", {
      reply_markup: { inline_keyboard: buttons },
    });
  }
  // --- pilih segmentasi ---
// --- pilih segmentasi ---
else if (callback_query?.data.startsWith("seg_")) {
  const segName = callback_query.data.split("_")[1];
  const chatId = callback_query.message.chat.id;
  userState[chatId] = { segmentasi: segName };

  // Ambil semua designator (karena sama untuk semua segmentasi)
  const { data: designators, error } = await supabase
    .from("designator")
    .select("Designator");

  if (error) {
    console.error(error);
    return bot.sendMessage(chatId, "❌ Gagal mengambil data designator dari server.");
  }

  if (!designators?.length) {
    return bot.sendMessage(chatId, "Tidak ada data designator tersedia.");
  }

  // Hanya tampilkan kolom 'Designator' sebagai tombol
  const buttons = designators.map((d) => [
    {
      text: d.Designator,
      callback_data: `des_${encodeURIComponent(d.Designator)}`,
    },
  ]);

  await bot.sendMessage(chatId, `📍 Segmentasi *${segName}* dipilih.\nSekarang pilih designator:`, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons },
  });
}

  // --- pilih designator ---
  else if (callback_query?.data.startsWith("des_")) {
    const chatId = callback_query.message.chat.id;
    const desId = callback_query.data.split("_")[1];
    userState[chatId].designator_id = desId;

    await bot.sendMessage(
      chatId,
      "📸 Silakan kirim foto eviden pekerjaan."
    );
  }

  // --- kirim foto ---
  else if (message?.photo) {
    const chatId = message.chat.id;
    const fileId = message.photo[message.photo.length - 1].file_id;
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${(await bot.getFile(fileId)).file_path}`;

    if (!userState[chatId]) userState[chatId] = {};
    userState[chatId].foto_url = fileUrl;

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
    userState[chatId].lokasi_latitude = latitude;
    userState[chatId].lokasi_longitude = longitude;

    await bot.sendMessage(chatId, "✏️ Terakhir, kirim keterangan tambahan:");
  }

  // --- kirim keterangan ---
  else if (
    message?.text &&
    !message.text.startsWith("/") &&
    userState[message.chat.id]?.designator_id
  ) {
    const chatId = message.chat.id;
    const userId = message.from.id;
    const data = userState[chatId];
    data.keterangan = message.text;

    // Simpan ke Supabase
    const { error } = await supabase.from("data_survey").insert([
      {
        telegram_user_id: userId,
        segmentasi_id: data.segmentasi_id,
        designator_id: data.designator_id,
        keterangan: data.keterangan,
        lokasi_latitude: data.lokasi_latitude,
        lokasi_longitude: data.lokasi_longitude,
        foto_url: data.foto_url,
      },
    ]);

    if (error) {
      console.error(error);
      await bot.sendMessage(chatId, "❌ Gagal menyimpan data ke server.");
    } else {
      await bot.sendMessage(
        chatId,
        "✅ Laporan berhasil dikirim!\nTerima kasih atas partisipasi Anda."
      );
    }

    delete userState[chatId];
  }

  res.status(200).send("OK");
}
