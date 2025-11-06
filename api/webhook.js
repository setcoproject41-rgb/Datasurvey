import TelegramBot from "node-telegram-bot-api";
import { supabase } from "../supabaseClient.js";

const bot = new TelegramBot(process.env.BOT_TOKEN);
const userState = {}; // state sementara per user

// ------------------- Helper Functions -------------------
const formatRupiah = (value) =>
value ? `Rp${Number(value).toLocaleString("id-ID")}` : "-";

const sendMessage = (chatId, text, options = {}) =>
bot.sendMessage(chatId, text, options);

const sendInlineKeyboard = (chatId, text, buttons, parse_mode = "Markdown") =>
sendMessage(chatId, text, {
parse_mode,
reply_markup: { inline_keyboard: buttons },
});

// ------------------- Main Handler -------------------
export default async function handler(req, res) {
if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

const { message, callback_query } = req.body;

const chatId = message?.chat?.id || callback_query?.message?.chat?.id;

// ------------------- START COMMAND -------------------
if (message?.text === "/start") {
const keyboard = {
inline_keyboard: [
[{ text: "📋 LAPORAN", callback_data: "menu_laporan" },
{ text: "📊 REPORT", callback_data: "menu_report" }],
[{ text: "ℹ️ INFO", callback_data: "menu_info" }],
],
};
await sendMessage(
chatId,
`👋 Selamat datang di *Bot Pelaporan Survey Lapangan!*\n\nSilakan pilih menu:`,
{ parse_mode: "Markdown", reply_markup: keyboard }
);
return res.status(200).send("OK");
}

// ------------------- CALLBACK QUERY HANDLER -------------------
if (callback_query?.data) {
const data = callback_query.data;

```
switch (true) {
  // --- MENU LAPORAN ---
  case data === "menu_laporan": {
    const { data: segList, error } = await supabase
      .from("segmentasi")
      .select("id, nama_segmentasi");
    if (error || !segList?.length) return sendMessage(chatId, "❌ Gagal ambil data segmentasi.");
    const buttons = segList.map(s => [
  { text: s.nama_segmentasi, callback_data: `lapor_seg_${encodeURIComponent(s.nama_segmentasi)}` }
]);

    return sendInlineKeyboard(chatId, "Pilih segmentasi untuk laporan:", buttons);
  }

  case data.startsWith("lapor_seg_"): {
    const segName = data.replace("lapor_seg_", "");
    const { data: designators, error } = await supabase.from("designator").select("designator");
    if (error || !designators?.length) return sendMessage(chatId, "❌ Gagal mengambil data designator.");

    userState[chatId] = { segmentasi: segName };
    const buttons = designators.map(d => [{ text: d.designator, callback_data: `lapor_des_${encodeURIComponent(d.designator)}` }]);
    return sendInlineKeyboard(chatId, `📍 Segmentasi *${segName}* dipilih.\nSekarang pilih designator:`, buttons);
  }

  case data.startsWith("lapor_des_"): {
    const designator = decodeURIComponent(data.replace("lapor_des_", ""));
    const segName = userState[chatId]?.segmentasi;
    if (!segName) return sendMessage(chatId, "⚠️ Segmentasi tidak ditemukan. Ulangi dengan /start.");

    const folderPath = `${segName}/${designator}`;
    const { data: draftRow, error: insertErr } = await supabase
      .from("data_survey")
      .insert([{ telegram_user_id: chatId, segmentasi: segName, designator, folder_path: folderPath, created_at: new Date(), total: 0 }])
      .select("id").single();
    if (insertErr) return sendMessage(chatId, "❌ Gagal membuat draft laporan.");

    userState[chatId] = { draft_id: draftRow.id, segmentasi: segName, designator, folder_path: folderPath, foto_urls: [] };
    return sendMessage(chatId, "📸 Kirim foto eviden pekerjaan.");
  }

  case data === "lapor_kirim": {
    const dataUser = userState[chatId];
    if (!dataUser?.draft_id) return sendMessage(chatId, "⚠️ Tidak ada draft aktif.");
    await supabase.from("data_survey").update({ created_at: new Date() }).eq("id", dataUser.draft_id);
    delete userState[chatId];
    return sendMessage(chatId, "✅ Laporan berhasil dikirim! Terima kasih 🙏");
  }

  case data === "lapor_batal": {
    delete userState[chatId];
    return sendMessage(chatId, "❌ Laporan dibatalkan.");
  }

  // --- MENU REPORT ---
  case data === "menu_report": {
    const { data: segList, error } = await supabase.from("segmentasi").select("nama_segmentasi");
    if (error || !segList?.length) return sendMessage(chatId, "❌ Tidak ada data segmentasi.");
    const buttons = segList.map(s => [{ text: s.nama_segmentasi, callback_data: `report_seg_${s.nama_segmentasi}` }]);
    return sendInlineKeyboard(chatId, "Pilih segmentasi untuk melihat laporan:", buttons);
  }

  case data.startsWith("report_seg_"): {
    const segName = data.replace("report_seg_", "");
    const { data, error } = await supabase.from("data_survey").select("designator, nilai_material, nilai_jasa, total").eq("segmentasi", segName);
    if (error || !data?.length) return sendMessage(chatId, "Tidak ada data untuk segmentasi ini.");
    let msg = `📊 *REPORT\n ${segName.toUpperCase()}*\n\n`;
    data.forEach(d => {
      msg += `🔧 *${d.designator}*\n + 📦 Material : ${formatRupiah(d.nilai_material)}\n + 🧰 Jasa : ${formatRupiah(d.nilai_jasa)}\n + 💰 Total : *${formatRupiah(d.total)}*\n\n`;
    });
    return sendMessage(chatId, msg, { parse_mode: "Markdown" });
  }

  // --- MENU INFO ---
  case data === "menu_info": {
    const { data: categories, error } = await supabase.from("designator").select("category").neq("category", null);
    if (error || !categories?.length) return sendMessage(chatId, "❌ Tidak ada kategori.");
    const uniqueCategories = [...new Set(categories.map(c => c.category))];
    const buttons = uniqueCategories.map(c => [{ text: c, callback_data: `info_cat_${encodeURIComponent(c)}` }]);
    return sendInlineKeyboard(chatId, "Pilih kategori:", buttons);
  }

  case data.startsWith("info_cat_"): {
    const category = decodeURIComponent(data.replace("info_cat_", ""));
    const { data: designators, error } = await supabase.from("designator").select("designator").eq("category", category);
    if (error || !designators?.length) return sendMessage(chatId, "Tidak ada designator untuk kategori ini.");
    const buttons = designators.map(d => [{ text: d.designator, callback_data: `info_des_${encodeURIComponent(d.designator)}` }]);
    return sendInlineKeyboard(chatId, `Kategori: *${category}*`, buttons);
  }

  case data.startsWith("info_des_"): {
    const designator = decodeURIComponent(data.replace("info_des_", ""));
    const { data, error } = await supabase.from("designator").select("uraian_pekerjaan, satuan, nilai_material, nilai_jasa").eq("designator", designator).single();
    if (error || !data) return sendMessage(chatId, "❌ Data designator tidak ditemukan.");
    const msg = `📘 *DETAIL DESIGNATOR*\n🔧 Designator : *${designator}*\n📏 Satuan : ${data.satuan || "-"}\n📝 Uraian : ${data.uraian_pekerjaan || "-"}\n📦 Material : ${formatRupiah(data.nilai_material)}\n🧰 Jasa : ${formatRupiah(data.nilai_jasa)}\n💰 Total : *${formatRupiah((data.nilai_material || 0) + (data.nilai_jasa || 0))}*`;
    return sendMessage(chatId, msg, { parse_mode: "Markdown" });
  }
}
```

}

// ------------------- MESSAGE HANDLER -------------------
if (message) {
const text = message.text?.toLowerCase();

```
// --- Kirim foto ---
if (message.photo) {
  const fileId = message.photo[message.photo.length - 1].file_id;
  const file = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(fileUrl);
  const buffer = await response.arrayBuffer();

  if (!userState[chatId]?.folder_path) return sendMessage(chatId, "⚠️ Kirim /start ulang, sesi laporan tidak aktif.");
  const folder = userState[chatId].folder_path;
  const fileName = `eviden_${Date.now()}.jpg`;
  const { error: uploadError } = await supabase.storage.from("evidence").upload(`${folder}/${fileName}`, buffer, { contentType: "image/jpeg" });
  if (uploadError) return sendMessage(chatId, "❌ Gagal upload foto ke storage Supabase.");

  const { data: publicUrlData } = supabase.storage.from("evidence").getPublicUrl(`${folder}/${fileName}`);
  userState[chatId].foto_urls.push(publicUrlData.publicUrl);

  await supabase.from("data_survey").update({ foto_url: userState[chatId].foto_urls.join(", ") }).eq("id", userState[chatId].draft_id);
  return sendMessage(chatId, "📸 Foto berhasil diunggah. Kirim foto lain jika ada, atau ketik *selesai* bila sudah cukup.", { parse_mode: "Markdown" });
}

// --- Selesai kirim foto ---
if (text === "selesai" && userState[chatId]) {
  return sendMessage(chatId, "📍 Sekarang kirim *lokasi* Anda (gunakan fitur share location).", { parse_mode: "Markdown" });
}

// --- Kirim lokasi ---
if (message.location && userState[chatId]) {
  const { latitude, longitude } = message.location;
  userState[chatId].lokasi = `${latitude},${longitude}`;
  await supabase.from("data_survey").update({ lokasi: userState[chatId].lokasi }).eq("id", userState[chatId].draft_id);
  return sendMessage(chatId, "✏️ Terakhir, kirim keterangan tambahan:");
}

// --- Kirim keterangan ---
if (text && userState[chatId]?.draft_id) {
  userState[chatId].keterangan = message.text;
  await supabase.from("data_survey").update({ keterangan: message.text }).eq("id", userState[chatId].draft_id);

  const data = userState[chatId];
  const summary = `🧾 *Konfirmasi Laporan Anda:*\n📍 Segmentasi: *${data.segmentasi}*\n🔧 Designator: *${data.designator}*\n🗺️ Lokasi: ${data.lokasi}\n📝 Keterangan: ${data.keterangan}\n📷 Jumlah Foto: ${data.foto_urls.length}\n\nApakah Anda ingin mengirim laporan ini?`;

  const buttons = [
    [{ text: "✅ Kirim", callback_data: "lapor_kirim" }, { text: "❌ Batal", callback_data: "lapor_batal" }],
  ];

  return sendInlineKeyboard(chatId, summary, buttons);
}
```

}

res.status(200).send("OK");
}
