import TelegramBot from "node-telegram-bot-api";
import { supabase } from "../supabaseClient.js";

const bot = new TelegramBot(process.env.BOT_TOKEN);
const userState = {}; // state sementara per user

export default async function handler(req, res) {
  // --- agar tidak timeout di vercel ---
  res.status(200).send("OK");
  if (req.method !== "POST") return;

  try {
    const update = req.body;
    const message = update.message;
    const callback = update.callback_query;

    const chatId =
      message?.chat?.id ||
      callback?.message?.chat?.id ||
      callback?.from?.id;

    if (!chatId) return console.warn("⚠️ chatId tidak ditemukan.");

    // ========== MENU START ==========
    if (message?.text === "/start") {
      userState[chatId] = {}; // reset state
      await bot.sendMessage(
        chatId,
        "👋 Selamat datang di *Bot Pelaporan Survey Lapangan!*\n\nSilakan pilih menu:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "📋 LAPORAN", callback_data: "menu_laporan" },
                { text: "📊 REPORT", callback_data: "menu_report" },
              ],
              [{ text: "ℹ️ INFO", callback_data: "menu_info" }],
            ],
          },
        }
      );
      return;
    }

    // ========== MENU LAPORAN ==========
    if (callback?.data === "menu_laporan") {
      const { data: segList, error } = await supabase
        .from("segmentasi")
        .select("id, nama_segmentasi");

      if (error || !segList?.length)
        return bot.sendMessage(chatId, "❌ Gagal ambil data segmentasi.");

      const buttons = segList.map((s) => [
        { text: s.nama_segmentasi, callback_data: `seg_${s.id}` },
      ]);

      await bot.sendMessage(chatId, "Pilih segmentasi:", {
        reply_markup: { inline_keyboard: buttons },
      });
      return;
    }

    // ========== PILIH SEGMENTASI ==========
    if (callback?.data?.startsWith("seg_")) {
      const segId = callback.data.replace("seg_", "");
      const { data: segData, error: segErr } = await supabase
        .from("segmentasi")
        .select("nama_segmentasi")
        .eq("id", segId)
        .single();

      if (segErr || !segData)
        return bot.sendMessage(chatId, "❌ Segmentasi tidak ditemukan.");

      const segName = segData.nama_segmentasi;
      userState[chatId] = { segmentasi_id: segId, segmentasi: segName };

      const { data: categories, error: catErr } = await supabase
        .from("designator")
        .select("category")
        .not("category", "is", null);

      if (catErr || !categories?.length)
        return bot.sendMessage(chatId, "❌ Tidak ada kategori ditemukan.");

      const uniqueCats = [...new Set(categories.map((c) => c.category))];
      const buttons = uniqueCats.map((cat) => [
        { text: cat, callback_data: `cat_${encodeURIComponent(cat)}` },
      ]);

      await bot.sendMessage(
        chatId,
        `📍 Segmentasi *${segName}* dipilih.\nSekarang pilih kategori:`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }
      );
      return;
    }

    // ========== PILIH CATEGORY ==========
    if (callback?.data?.startsWith("cat_")) {
      const category = decodeURIComponent(callback.data.replace("cat_", ""));
      userState[chatId] = { ...userState[chatId], category };

      const { data: designators, error } = await supabase
        .from("designator")
        .select("designator")
        .eq("category", category);

      if (error || !designators?.length)
        return bot.sendMessage(chatId, "❌ Tidak ada designator di kategori ini.");

      const buttons = designators.map((d) => [
        { text: d.designator, callback_data: `lapor_des_${encodeURIComponent(d.designator)}` },
      ]);

      await bot.sendMessage(
        chatId,
        `📦 Kategori *${category}* dipilih.\nSekarang pilih designator:`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }
      );
      return;
    }

    // ========== PILIH DESIGNATOR ==========
    if (callback?.data?.startsWith("lapor_des_")) {
      const designator = decodeURIComponent(callback.data.replace("lapor_des_", ""));
      const seg = userState[chatId]?.segmentasi;

      if (!seg) return bot.sendMessage(chatId, "⚠️ Pilih segmentasi dahulu.");

      const folderPath = `${seg}/${designator}`;

      const { data: draftRow, error } = await supabase
        .from("data_survey")
        .insert([
          {
            telegram_user_id: chatId,
            segmentasi: seg,
            designator,
            folder_path: folderPath,
            created_at: new Date(),
            total: 0,
          },
        ])
        .select("id")
        .single();

      if (error) {
        console.error("Insert error:", error);
        return bot.sendMessage(chatId, "❌ Gagal membuat draft laporan.");
      }

      userState[chatId] = {
        ...userState[chatId],
        draft_id: draftRow.id,
        designator,
        folder_path: folderPath,
        foto_urls: [],
      };

      await bot.sendMessage(chatId, "📸 Kirim foto eviden pekerjaan.");
      return;
    }

    // ========== KIRIM FOTO ==========
    if (message?.photo) {
      const state = userState[chatId];
      if (!state?.folder_path)
        return bot.sendMessage(chatId, "⚠️ Sesi tidak aktif. Ketik /start.");

      const fileId = message.photo.at(-1).file_id;
      const file = await bot.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      const buffer = await resp.arrayBuffer();

      const fileName = `eviden_${Date.now()}.jpg`;
      const { error: uploadErr } = await supabase.storage
        .from("evidence")
        .upload(`${state.folder_path}/${fileName}`, buffer, {
          contentType: "image/jpeg",
        });

      if (uploadErr) {
        console.error(uploadErr);
        return bot.sendMessage(chatId, "❌ Upload foto gagal.");
      }

      const { data: publicData } = supabase.storage
        .from("evidence")
        .getPublicUrl(`${state.folder_path}/${fileName}`);

      state.foto_urls.push(publicData.publicUrl);
      await supabase
        .from("data_survey")
        .update({ foto_url: state.foto_urls.join(", ") })
        .eq("id", state.draft_id);

      await bot.sendMessage(
        chatId,
        "📸 Foto tersimpan. Kirim foto lain atau ketik *selesai*.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    // ========== SELESAI FOTO ==========
    if (message?.text?.toLowerCase() === "selesai") {
      if (!userState[chatId]?.draft_id)
        return bot.sendMessage(chatId, "⚠️ Tidak ada sesi aktif.");
      await bot.sendMessage(chatId, "📍 Kirim lokasi Anda (share location).");
      return;
    }

    // ========== LOKASI ==========
    if (message?.location) {
      const { latitude, longitude } = message.location;
      const st = userState[chatId];
      if (!st?.draft_id)
        return bot.sendMessage(chatId, "⚠️ Tidak ada sesi aktif.");

      const lokasi = `${latitude},${longitude}`;
      st.lokasi = lokasi;

      await supabase
        .from("data_survey")
        .update({ lokasi })
        .eq("id", st.draft_id);

      await bot.sendMessage(chatId, "✏️ Kirim keterangan tambahan:");
      return;
    }

    // ========== KETERANGAN ==========
    if (message?.text && userState[chatId]?.draft_id && !["selesai", "/start"].includes(message.text.toLowerCase())) {
      const st = userState[chatId];
      st.keterangan = message.text;

      await supabase
        .from("data_survey")
        .update({ keterangan: st.keterangan })
        .eq("id", st.draft_id);

      const summary = `
🧾 *Konfirmasi Laporan Anda:*

📍 Segmentasi: *${st.segmentasi}*
🔧 Designator: *${st.designator}*
🗺️ Lokasi: ${st.lokasi}
📝 Keterangan: ${st.keterangan}
📷 Foto: ${st.foto_urls.length}

Kirim laporan ini?`;

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
      return;
    }

    // ========== KONFIRMASI KIRIM ==========
    if (callback?.data === "lapor_kirim") {
      const st = userState[chatId];
      if (!st?.draft_id)
        return bot.sendMessage(chatId, "⚠️ Tidak ada laporan aktif.");

      await supabase
        .from("data_survey")
        .update({ created_at: new Date() })
        .eq("id", st.draft_id);

      await bot.sendMessage(chatId, "✅ Laporan berhasil dikirim!");
      delete userState[chatId];
      return;
    }

    if (callback?.data === "lapor_batal") {
      delete userState[chatId];
      await bot.sendMessage(chatId, "❌ Laporan dibatalkan.");
      return;
    }

    // ========== MENU REPORT ==========
    if (callback?.data === "menu_report") {
      const { data: segList, error } = await supabase
        .from("segmentasi")
        .select("nama_segmentasi");

      if (error || !segList?.length)
        return bot.sendMessage(chatId, "❌ Tidak ada data segmentasi.");

      const buttons = segList.map((s) => [
        { text: s.nama_segmentasi, callback_data: `report_seg_${s.nama_segmentasi}` },
      ]);

      await bot.sendMessage(chatId, "Pilih segmentasi untuk laporan:", {
        reply_markup: { inline_keyboard: buttons },
      });
      return;
    }

    if (callback?.data?.startsWith("report_seg_")) {
      const segName = callback.data.replace("report_seg_", "");
      const { data, error } = await supabase
        .from("data_survey")
        .select("designator, nilai_material, nilai_jasa, total")
        .eq("segmentasi", segName);

      if (error || !data?.length)
        return bot.sendMessage(chatId, "Tidak ada data untuk segmentasi ini.");

      let msg = `📊 *REPORT*\n${segName}\n\n`;
      for (const d of data) {
        msg += `🔧 *${d.designator}*\n📦 Material: Rp${d.nilai_material?.toLocaleString("id-ID") || "-"}\n🧰 Jasa: Rp${d.nilai_jasa?.toLocaleString("id-ID") || "-"}\n💰 Total: Rp${d.total?.toLocaleString("id-ID") || "-"}\n\n`;
      }
      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
      return;
    }

    // ========== MENU INFO ==========
    if (callback?.data === "menu_info") {
      const { data: categories, error } = await supabase
        .from("designator")
        .select("category")
        .not("category", "is", null);

      if (error || !categories?.length)
        return bot.sendMessage(chatId, "❌ Tidak ada kategori.");

      const cats = [...new Set(categories.map((c) => c.category))];
      const buttons = cats.map((c) => [
        { text: c, callback_data: `info_cat_${encodeURIComponent(c)}` },
      ]);

      await bot.sendMessage(chatId, "Pilih kategori:", {
        reply_markup: { inline_keyboard: buttons },
      });
      return;
    }

    if (callback?.data?.startsWith("info_cat_")) {
      const cat = decodeURIComponent(callback.data.replace("info_cat_", ""));
      const { data, error } = await supabase
        .from("designator")
        .select("designator")
        .eq("category", cat);

      if (error || !data?.length)
        return bot.sendMessage(chatId, "Tidak ada designator untuk kategori ini.");

      const buttons = data.map((d) => [
        { text: d.designator, callback_data: `info_des_${encodeURIComponent(d.designator)}` },
      ]);

      await bot.sendMessage(chatId, `Kategori: *${cat}*`, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons },
      });
      return;
    }

    if (callback?.data?.startsWith("info_des_")) {
      const des = decodeURIComponent(callback.data.replace("info_des_", ""));
      const { data, error } = await supabase
        .from("designator")
        .select("uraian_pekerjaan, satuan, nilai_material, nilai_jasa")
        .eq("designator", des)
        .single();

      if (error || !data)
        return bot.sendMessage(chatId, "❌ Data tidak ditemukan.");

      const msg = `
📘 *DETAIL DESIGNATOR*
🔧 ${des}
📏 Satuan: ${data.satuan || "-"}
📝 Uraian: ${data.uraian_pekerjaan || "-"}
📦 Material: Rp${data.nilai_material?.toLocaleString("id-ID") || "-"}
🧰 Jasa: Rp${data.nilai_jasa?.toLocaleString("id-ID") || "-"}
💰 Total: Rp${((data.nilai_material || 0) + (data.nilai_jasa || 0)).toLocaleString("id-ID")}
`;

      await bot.sendMessage(chatId, msg.trim(), { parse_mode: "Markdown" });
      return;
    }

    // fallback
    await bot.sendMessage(chatId, "Gunakan /start untuk memulai.");
  } catch (e) {
    console.error("❌ Error handler:", e);
  }
}
