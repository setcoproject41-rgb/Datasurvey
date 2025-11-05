import TelegramBot from "node-telegram-bot-api";
import { supabase } from "../supabaseClient.js";

const bot = new TelegramBot(process.env.BOT_TOKEN);
const userState = {}; // state sementara per user

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const { message, callback_query } = req.body;

  // --------------------------- MENU AWAL ---------------------------
  if (message?.text === "/start") {
    const keyboard = {
      inline_keyboard: [
        [
          { text: "📋 LAPORAN", callback_data: "menu_laporan" },
          { text: "📊 REPORT", callback_data: "menu_report" },
        ],
        [{ text: "ℹ️ INFO", callback_data: "menu_info" }],
      ],
    };

    await bot.sendMessage(
      message.chat.id,
      `👋 Selamat datang di *Bot Pelaporan Survey Lapangan!*\n\nSilakan pilih menu:`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  }

  // --------------------------- MENU LAPORAN ---------------------------
  else if (callback_query?.data === "menu_laporan") {
    const chatId = callback_query.message.chat.id;

    const { data: segList, error } = await supabase
      .from("segmentasi")
      .select("id, nama_segmentasi");

    if (error || !segList?.length)
      return bot.sendMessage(chatId, "❌ Gagal ambil data segmentasi.");

    const buttons = segList.map((s) => [
      { text: s.nama_segmentasi, callback_data: `lapor_seg_${s.nama_segmentasi}` },
    ]);

    await bot.sendMessage(chatId, "Pilih segmentasi untuk laporan:", {
      reply_markup: { inline_keyboard: buttons },
    });
  }

  // --- pilih segmentasi laporan ---
  else if (callback_query?.data.startsWith("lapor_seg_")) {
    const chatId = callback_query.message.chat.id;
    const segName = callback_query.data.replace("lapor_seg_", "");

    const { data: designators, error } = await supabase
      .from("designator")
      .select("designator");

    if (error || !designators?.length)
      return bot.sendMessage(chatId, "❌ Gagal mengambil data designator.");

    userState[chatId] = { segmentasi: segName };

    const buttons = designators.map((d) => [
      { text: d.designator, callback_data: `lapor_des_${encodeURIComponent(d.designator)}` },
    ]);

    await bot.sendMessage(
      chatId,
      `📍 Segmentasi *${segName}* dipilih.\nSekarang pilih designator:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }
    );
  }

  // --- pilih designator laporan ---
  else if (callback_query?.data.startsWith("lapor_des_")) {
    const chatId = callback_query.message.chat.id;
    const designator = decodeURIComponent(callback_query.data.replace("lapor_des_", ""));
    const segName = userState[chatId]?.segmentasi;

    if (!segName) return bot.sendMessage(chatId, "⚠️ Segmentasi tidak ditemukan. Ulangi dengan /start.");

    // buat draft row di database
    const folderPath = `${segName}/${designator}`;
    const { data: draftRow, error: insertErr } = await supabase
      .from("data_survey")
      .insert([
        {
          telegram_user_id: chatId,
          segmentasi: segName,
          designator,
          folder_path: folderPath,
          created_at: new Date(),
          total: 0,
        },
      ])
      .select("id")
      .single();

    if (insertErr) {
      console.error(insertErr);
      return bot.sendMessage(chatId, "❌ Gagal membuat draft laporan.");
    }

    userState[chatId] = {
      draft_id: draftRow.id,
      segmentasi: segName,
      designator,
      folder_path: folderPath,
      foto_urls: [],
    };

    await bot.sendMessage(chatId, "📸 Kirim foto eviden pekerjaan.");
  }

  // --- kirim foto eviden ---
  else if (message?.photo) {
    const chatId = message.chat.id;
    const fileId = message.photo[message.photo.length - 1].file_id;
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(fileUrl);
    const buffer = await response.arrayBuffer();

    if (!userState[chatId]?.folder_path) {
      return bot.sendMessage(chatId, "⚠️ Kirim /start ulang, sesi laporan tidak aktif.");
    }

    const folder = userState[chatId].folder_path;
    const fileName = `eviden_${Date.now()}.jpg`;

    const { error: uploadError } = await supabase.storage
      .from("evidence")
      .upload(`${folder}/${fileName}`, buffer, { contentType: "image/jpeg" });

    if (uploadError) {
      console.error(uploadError);
      return bot.sendMessage(chatId, "❌ Gagal upload foto ke storage Supabase.");
    }

    const { data: publicUrlData } = supabase.storage
      .from("evidence")
      .getPublicUrl(`${folder}/${fileName}`);

    userState[chatId].foto_urls.push(publicUrlData.publicUrl);

    // update foto_url ke draft row
    await supabase
      .from("data_survey")
      .update({ foto_url: userState[chatId].foto_urls.join(", ") })
      .eq("id", userState[chatId].draft_id);

    await bot.sendMessage(
      chatId,
      "📸 Foto berhasil diunggah. Kirim foto lain jika ada, atau ketik *selesai* bila sudah cukup.",
      { parse_mode: "Markdown" }
    );
  }

  // --- selesai kirim foto ---
  else if (message?.text?.toLowerCase() === "selesai" && userState[message.chat.id]) {
    await bot.sendMessage(
      message.chat.id,
      "📍 Sekarang kirim *lokasi* Anda (gunakan fitur share location).",
      { parse_mode: "Markdown" }
    );
  }

  // --- kirim lokasi ---
  else if (message?.location && userState[message.chat.id]) {
    const chatId = message.chat.id;
    const { latitude, longitude } = message.location;
    userState[chatId].lokasi = `${latitude},${longitude}`;

    await supabase
      .from("data_survey")
      .update({ lokasi: userState[chatId].lokasi })
      .eq("id", userState[chatId].draft_id);

    await bot.sendMessage(chatId, "✏️ Terakhir, kirim keterangan tambahan:");
  }

  // --- kirim keterangan ---
  else if (message?.text && userState[message.chat.id]?.draft_id) {
    const chatId = message.chat.id;
    const data = userState[chatId];
    data.keterangan = message.text;

    await supabase
      .from("data_survey")
      .update({ keterangan: data.keterangan })
      .eq("id", data.draft_id);

    const summary = `
🧾 *Konfirmasi Laporan Anda:*

📍 Segmentasi: *${data.segmentasi}*
🔧 Designator: *${data.designator}*
🗺️ Lokasi: ${data.lokasi}
📝 Keterangan: ${data.keterangan}
📷 Jumlah Foto: ${data.foto_urls.length}

Apakah Anda ingin mengirim laporan ini?
`;

    await bot.sendMessage(chatId, summary, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Kirim", callback_data: "lapor_kirim" },
            { text: "❌ Batal", callback_data: "lapor_batal" },
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
  }

  // 🔹 Ambil nilai dari tabel designator
  const { data: designatorData, error: designatorError } = await supabase
    .from("designator")
    .select("nilai_material, nilai_jasa")
    .eq("designator", data.designator)
    .single();

  if (designatorError || !designatorData) {
    console.error(designatorError);
    return bot.sendMessage(chatId, "❌ Gagal mengambil data nilai dari designator.");
  }

  const nilai_material = designatorData.nilai_material || 0;
  const nilai_jasa = designatorData.nilai_jasa || 0;
  const total = nilai_material + nilai_jasa;

  // 🔹 Simpan ke tabel data_survey
  const { error } = await supabase.from("data_survey").insert([
    {
      telegram_user_id: userId,
      segmentasi: data.segmentasi,
      designator: data.designator,
      folder_path: `${data.segmentasi}/${data.designator}`,
      foto_url: data.foto_urls.join(", "),
      lokasi: data.lokasi,
      keterangan: data.keterangan,
      nilai_material,
      nilai_jasa,
      total,
    },
  ]);

  if (error) {
    console.error(error);
    await bot.sendMessage(chatId, "❌ Gagal menyimpan data ke server.");
  } else {
    await bot.sendMessage(chatId, "✅ Laporan berhasil dikirim! Nilai otomatis sudah dihitung 🙏");
  }

  delete userState[chatId];
}

  // --- batal kirim ---
  else if (callback_query?.data === "lapor_batal") {
    const chatId = callback_query.message.chat.id;
    delete userState[chatId];
    await bot.sendMessage(chatId, "❌ Laporan dibatalkan.");
  }

  // --------------------------- MENU REPORT ---------------------------
  else if (callback_query?.data === "menu_report") {
    const chatId = callback_query.message.chat.id;

    const { data: segList, error } = await supabase
      .from("segmentasi")
      .select("nama_segmentasi");

    if (error || !segList?.length)
      return bot.sendMessage(chatId, "❌ Tidak ada data segmentasi.");

    const buttons = segList.map((s) => [
      { text: s.nama_segmentasi, callback_data: `report_seg_${s.nama_segmentasi}` },
    ]);

    await bot.sendMessage(chatId, "Pilih segmentasi untuk melihat laporan:", {
      reply_markup: { inline_keyboard: buttons },
    });
  }

  // --- tampilkan rekap laporan ---
  else if (callback_query?.data.startsWith("report_seg_")) {
    const chatId = callback_query.message.chat.id;
    const segName = callback_query.data.replace("report_seg_", "");

    const { data, error } = await supabase
      .from("data_survey")
      .select("designator, nilai_material, nilai_jasa, total")
      .eq("segmentasi", segName);

    if (error || !data?.length)
      return bot.sendMessage(chatId, "Tidak ada data untuk segmentasi ini.");

    let msg = `📊 *REPORT ${segName.toUpperCase()}*\n\n`;
    data.forEach((d) => {
      msg += `🔧 *${d.designator}*\nMaterial: ${d.nilai_material ?? 0}\nJasa: ${d.nilai_jasa ?? 0}\nTotal: ${d.total ?? 0}\n\n`;
    });

    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
  }

  // --------------------------- MENU INFO ---------------------------
  else if (callback_query?.data === "menu_info") {
    const chatId = callback_query.message.chat.id;

    const { data: categories, error } = await supabase
      .from("designator")
      .select("category")
      .neq("category", null);

    if (error || !categories?.length)
      return bot.sendMessage(chatId, "❌ Tidak ada kategori.");

    const uniqueCategories = [...new Set(categories.map((c) => c.category))];

    const buttons = uniqueCategories.map((c) => [
      { text: c, callback_data: `info_cat_${encodeURIComponent(c)}` },
    ]);

    await bot.sendMessage(chatId, "Pilih kategori:", {
      reply_markup: { inline_keyboard: buttons },
    });
  }

  // --- tampilkan daftar designator dalam kategori ---
  else if (callback_query?.data.startsWith("info_cat_")) {
    const chatId = callback_query.message.chat.id;
    const category = decodeURIComponent(callback_query.data.replace("info_cat_", ""));

    const { data: designators, error } = await supabase
      .from("designator")
      .select("designator")
      .eq("category", category);

    if (error || !designators?.length)
      return bot.sendMessage(chatId, "Tidak ada designator untuk kategori ini.");

    const buttons = designators.map((d) => [
      { text: d.designator, callback_data: `info_des_${encodeURIComponent(d.designator)}` },
    ]);

    await bot.sendMessage(chatId, `Kategori: *${category}*`, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: buttons },
    });
  }

  // --- tampilkan detail designator ---
  else if (callback_query?.data.startsWith("info_des_")) {
    const chatId = callback_query.message.chat.id;
    const designator = decodeURIComponent(callback_query.data.replace("info_des_", ""));

    const { data, error } = await supabase
      .from("designator")
      .select("uraian_pekerjaan, satuan, nilai_material, nilai_jasa")
      .eq("designator", designator)
      .single();

    if (error || !data)
      return bot.sendMessage(chatId, "❌ Data designator tidak ditemukan.");

    const msg = `
📘 *DETAIL*
Designator: *${designator}*
Satuan: ${data.satuan}
Uraian: ${data.uraian_pekerjaan}
Nilai Material: ${data.nilai_material}
Nilai Jasa: ${data.nilai_jasa}
`;

    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
  }

  res.status(200).send("OK");
}
