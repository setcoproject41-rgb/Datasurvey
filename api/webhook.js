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

  // --- kirim foto ---
  else if (message?.photo) {
    const chatId = message.chat.id;
    const fileId = message.photo[message.photo.length - 1].file_id;
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

    if (!userState[chatId]) userState[chatId] = {};
    userState[chatId].foto_url = fileUrl;

    await bot.sendMessage(chatId, "📍 Sekarang kirim *lokasi* Anda (gunakan share location).", {
      parse_mode: "Markdown",
    });
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
    const userId = message.from.id;
    const data = userState[chatId];
    data.keterangan = message.text;

    // Simpan ke Supabase
    const { error } = await supabase.from("data_survey").insert([
      {
        telegram_user_id: userId,
        segmentasi: data.segmentasi,
        designator: data.designator,
        folder_path: data.folder_path,
        foto_url: data.foto_url,
        lokasi: data.lokasi,
        keterangan: data.keterangan,
      },
    ]);

    if (error) {
      console.error(error);
      await bot.sendMessage(chatId, "❌ Gagal menyimpan data ke server.");
    } else {
      await bot.sendMessage(
        chatId,
        `✅ Laporan berhasil dikirim!\n\n📁 Folder: *${data.folder_path}*`,
        { parse_mode: "Markdown" }
      );
    }

    delete userState[chatId];
  }

  res.status(200).send("OK");
}
