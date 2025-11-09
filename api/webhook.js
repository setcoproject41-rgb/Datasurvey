// api/webhook.js
import TelegramBot from "node-telegram-bot-api";
import { supabase } from "../supabaseClient.js";

// NOTE: Do NOT enable polling on serverless. Instantiate without polling.
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.BOT; // try common names
if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN env var");
}
const bot = new TelegramBot(BOT_TOKEN);

// in serverless we *do not* call bot.setWebHook here automatically.
// Set webhook manually (instructions below) or set it in startup script.

const userState = {}; // session state in-memory (ephemeral)

/**
 * Webhook handler invoked by Vercel
 * - Always respond 200 quickly to avoid platform issues
 * - Process update with bot.processUpdate so event handlers run
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }

  // respond early to Telegram
  res.status(200).send("OK");

  try {
    // process update (will trigger event handlers registered below)
    await bot.processUpdate(req.body);
  } catch (e) {
    console.error("processUpdate error:", e);
  }
}

/* ------------------------
   BOT event handlers
   ------------------------ */

// /start command: show main menu
bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    userState[chatId] = {}; // reset session

    const keyboard = {
      inline_keyboard: [
        [
          { text: "📋 LAPORAN", callback_data: "menu_laporan" },
          { text: "📊 REPORT", callback_data: "menu_report" }
        ],
        [{ text: "ℹ️ INFO", callback_data: "menu_info" }]
      ]
    };

    await bot.sendMessage(
      chatId,
      `👋 Selamat datang di *Bot Pelaporan Survey Lapangan!*\n\nSilakan pilih menu:`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  } catch (err) {
    console.error("/start handler error:", err);
  }
});

// callback_query central handler
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  // Answer callback query quick so Telegram UI doesn't show loading forever
  try {
    await bot.answerCallbackQuery(query.id);
  } catch (e) {
    // ignore
  }

  try {
    // ----------------- MENU LAPORAN -----------------
    if (data === "menu_laporan") {
      const { data: segList, error } = await supabase
        .from("segmentasi")
        .select("id, nama_segmentasi");

      if (error || !segList?.length) {
        return bot.sendMessage(chatId, "❌ Gagal ambil data segmentasi.");
      }

      const buttons = segList.map((s) => [
        { text: s.nama_segmentasi, callback_data: `seg_${s.id}` }
      ]);

      return bot.sendMessage(chatId, "Pilih segmentasi:", {
        reply_markup: { inline_keyboard: buttons }
      });
    }

    // ----------------- PILIH SEGMENTASI -----------------
    if (data.startsWith("seg_")) {
      const segId = data.replace("seg_", "");
      const { data: seg, error } = await supabase
        .from("segmentasi")
        .select("nama_segmentasi")
        .eq("id", segId)
        .single();

      if (error || !seg) return bot.sendMessage(chatId, "❌ Segmentasi tidak ditemukan.");

      // save segmentasi name in state
      userState[chatId] = { ...(userState[chatId] || {}), segmentasi: seg.nama_segmentasi };

      // load categories from designator table
      const { data: catRows, error: catErr } = await supabase
        .from("designator")
        .select("category")
        .not("category", "is", null);

      if (catErr || !catRows?.length) return bot.sendMessage(chatId, "❌ Tidak ada kategori.");

      const categories = [...new Set(catRows.map((r) => r.category))];
      const buttons = categories.map((c) => [
        { text: c, callback_data: `cat_${encodeURIComponent(c)}` }
      ]);

      return bot.sendMessage(
        chatId,
        `📍 Segmentasi *${seg.nama_segmentasi}* dipilih.\nPilih kategori:`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }
      );
    }

    // ----------------- PILIH CATEGORY -----------------
    if (data.startsWith("cat_")) {
      const category = decodeURIComponent(data.replace("cat_", ""));
      userState[chatId] = { ...(userState[chatId] || {}), category };

      const { data: des, error } = await supabase
        .from("designator")
        .select("designator")
        .eq("category", category);

      if (error || !des?.length) return bot.sendMessage(chatId, "❌ Tidak ada designator di kategori ini.");

      const buttons = des.map((d) => [
        { text: d.designator, callback_data: `lapor_des_${encodeURIComponent(d.designator)}` }
      ]);

      return bot.sendMessage(
        chatId,
        `📦 Kategori *${category}* dipilih.\nPilih designator:`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }
      );
    }

    // ----------------- PILIH DESIGNATOR (buat draft) -----------------
    if (data.startsWith("lapor_des_")) {
      const designator = decodeURIComponent(data.replace("lapor_des_", ""));
      const seg = userState[chatId]?.segmentasi;
      if (!seg) return bot.sendMessage(chatId, "⚠️ Pilih segmentasi dahulu.");

      const folder = `${seg}/${designator}`;

      // insert draft row
      const { data: ins, error: insErr } = await supabase
        .from("data_survey")
        .insert([
          {
            telegram_user_id: String(chatId),
            segmentasi: seg,
            designator,
            folder_path: folder,
            created_at: new Date().toISOString(),
            total: 0
          }
        ])
        .select("id")
        .single();

      if (insErr) {
        console.error("Insert draft error:", insErr);
        return bot.sendMessage(chatId, "❌ Gagal membuat draft laporan.");
      }

      userState[chatId] = {
        ...(userState[chatId] || {}),
        draft_id: ins.id,
        designator,
        folder_path: folder,
        foto_urls: []
      };

      return bot.sendMessage(chatId, "📸 Kirim foto eviden pekerjaan (bisa beberapa).");
    }

    // ----------------- MENU REPORT -----------------
    if (data === "menu_report") {
      const { data: segList, error } = await supabase
        .from("segmentasi")
        .select("nama_segmentasi");

      if (error || !segList?.length) return bot.sendMessage(chatId, "❌ Tidak ada data segmentasi.");

      const buttons = segList.map((s) => [
        { text: s.nama_segmentasi, callback_data: `report_seg_${s.nama_segmentasi}` }
      ]);

      return bot.sendMessage(chatId, "Pilih segmentasi untuk melihat laporan:", {
        reply_markup: { inline_keyboard: buttons }
      });
    }

    if (data.startsWith("report_seg_")) {
      const segName = data.replace("report_seg_", "");
      const { data: rows, error } = await supabase
        .from("data_survey")
        .select("designator, nilai_material, nilai_jasa, total")
        .eq("segmentasi", segName);

      if (error || !rows?.length) return bot.sendMessage(chatId, "Tidak ada data untuk segmentasi ini.");

      let msg = `📊 *REPORT*\n${segName}\n\n`;
      for (const r of rows) {
        msg += `🔧 *${r.designator}*\n📦 Material: ${r.nilai_material ? `Rp${Number(r.nilai_material).toLocaleString("id-ID")}` : "-"}\n🧰 Jasa: ${r.nilai_jasa ? `Rp${Number(r.nilai_jasa).toLocaleString("id-ID")}` : "-"}\n💰 Total: ${r.total ? `Rp${Number(r.total).toLocaleString("id-ID")}` : "-"}\n\n`;
      }
      return bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    }

    // ----------------- MENU INFO -----------------
    if (data === "menu_info") {
      const { data: cats, error } = await supabase
        .from("designator")
        .select("category")
        .not("category", "is", null);

      if (error || !cats?.length) return bot.sendMessage(chatId, "❌ Tidak ada kategori.");

      const uniq = [...new Set(cats.map((c) => c.category))];
      const buttons = uniq.map((c) => [{ text: c, callback_data: `info_cat_${encodeURIComponent(c)}` }]);
      return bot.sendMessage(chatId, "Pilih kategori:", { reply_markup: { inline_keyboard: buttons } });
    }

    if (data.startsWith("info_cat_")) {
      const cat = decodeURIComponent(data.replace("info_cat_", ""));
      const { data: des, error } = await supabase
        .from("designator")
        .select("designator")
        .eq("category", cat);

      if (error || !des?.length) return bot.sendMessage(chatId, "Tidak ada designator untuk kategori ini.");

      const buttons = des.map((d) => [{ text: d.designator, callback_data: `info_des_${encodeURIComponent(d.designator)}` }]);
      return bot.sendMessage(chatId, `Kategori: *${cat}*`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
    }

    if (data.startsWith("info_des_")) {
      const des = decodeURIComponent(data.replace("info_des_", ""));
      const { data: d, error } = await supabase
        .from("designator")
        .select("uraian_pekerjaan, satuan, nilai_material, nilai_jasa")
        .eq("designator", des)
        .single();

      if (error || !d) return bot.sendMessage(chatId, "❌ Designator tidak ditemukan.");

      const mat = d.nilai_material ? `Rp${Number(d.nilai_material).toLocaleString("id-ID")}` : "-";
      const jas = d.nilai_jasa ? `Rp${Number(d.nilai_jasa).toLocaleString("id-ID")}` : "-";
      const total = `Rp${Number((d.nilai_material || 0) + (d.nilai_jasa || 0)).toLocaleString("id-ID")}`;

      return bot.sendMessage(chatId, `📘 *DETAIL DESIGNATOR*\n\n🔧 ${des}\n📏 Satuan: ${d.satuan || "-"}\n📝 ${d.uraian_pekerjaan || "-"}\n📦 Material: ${mat}\n🧰 Jasa: ${jas}\n💰 Total: *${total}*`, { parse_mode: "Markdown" });
    }

    // default fallback
    return bot.sendMessage(chatId, "Gunakan /start untuk memulai.");
  } catch (err) {
    console.error("callback_query handler error:", err);
    try { await bot.sendMessage(chatId, "Terjadi kesalahan. Coba lagi."); } catch (e) {}
  }
});

/* ------------------------
   MESSAGE handlers (photo, location, text for keterangan)
   these are triggered by bot.processUpdate when webhook posts update
   ------------------------ */

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  try {
    // photo handling
    if (msg.photo && msg.photo.length) {
      const state = userState[chatId];
      if (!state?.folder_path && !state?.draft_id) {
        // if folder_path missing but draft exists, set from userState.draft_id inspection (skip)
        return bot.sendMessage(chatId, "⚠️ Tidak ada sesi aktif. Ketik /start lalu buat laporan.");
      }

      // ensure folder_path exists in state (we set when creating draft)
      const folder = state.folder_path;
      if (!folder) return bot.sendMessage(chatId, "⚠️ Sesi tidak aktif. Pilih designator dulu.");

      const fileId = msg.photo.at(-1).file_id;
      const file = await bot.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      const r = await fetch(fileUrl);
      const buf = await r.arrayBuffer();

      const fileName = `eviden_${Date.now()}.jpg`;
      const { error: uploadErr } = await supabase.storage
        .from("evidence")
        .upload(`${folder}/${fileName}`, Buffer.from(buf), { contentType: "image/jpeg" });

      if (uploadErr) {
        console.error("storage upload err:", uploadErr);
        return bot.sendMessage(chatId, "❌ Gagal upload foto.");
      }

      const { data: publicData } = supabase.storage
        .from("evidence")
        .getPublicUrl(`${folder}/${fileName}`);

      state.foto_urls = state.foto_urls || [];
      state.foto_urls.push(publicData.publicUrl);

      // update foto_url on draft row
      if (state.draft_id) {
        await supabase
          .from("data_survey")
          .update({ foto_url: state.foto_urls.join(", ") })
          .eq("id", state.draft_id);
      }

      return bot.sendMessage(chatId, "📸 Foto berhasil diupload. Kirim foto lain atau ketik 'selesai'.");
    }

    // location handling
    if (msg.location) {
      const state = userState[chatId];
      if (!state?.draft_id) return bot.sendMessage(chatId, "⚠️ Tidak ada sesi aktif.");
      const lokasi = `${msg.location.latitude},${msg.location.longitude}`;
      state.lokasi = lokasi;
      await supabase.from("data_survey").update({ lokasi }).eq("id", state.draft_id);
      return bot.sendMessage(chatId, "✏️ Lokasi tersimpan. Sekarang kirim keterangan.");
    }

    // text handling for keterangan or other commands
    if (msg.text && !msg.text.startsWith("/")) {
      const text = msg.text.trim();
      const state = userState[chatId];

      // if user types 'selesai' -> ask for location (we support both exact match and lowercase)
      if (text.toLowerCase() === "selesai") {
        if (!state?.draft_id) return bot.sendMessage(chatId, "⚠️ Tidak ada sesi aktif.");
        return bot.sendMessage(chatId, "📍 Silakan kirim lokasi (gunakan share location).");
      }

      // If there's an active draft, treat as keterangan
      if (state?.draft_id) {
        state.keterangan = text;
        await supabase.from("data_survey").update({ keterangan: text }).eq("id", state.draft_id);

        const summary = `
🧾 *Konfirmasi Laporan Anda:*
📍 Segmentasi: *${state.segmentasi || "-"}*
🔧 Designator: *${state.designator || "-"}*
🗺️ Lokasi: ${state.lokasi || "-"}
📝 Keterangan: ${state.keterangan || "-"}
📷 Foto: ${state.foto_urls?.length || 0}

Kirim laporan ini?
`;
        return bot.sendMessage(chatId, summary, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Kirim", callback_data: "lapor_kirim" }, { text: "❌ Batal", callback_data: "lapor_batal" }]
            ]
          }
        });
      }
    }
  } catch (err) {
    console.error("message handler error:", err);
  }
});

// finalize sending: when user confirms send (lapor_kirim) we update created_at (already set on draft insert)
// the callback handler above already listens for "lapor_kirim" via callback_query path

    // ---------------- MENU REPORT ----------------
    else if (data === "menu_report") {
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

    // Tampilkan report segmentasi
    else if (data.startsWith("report_seg_")) {
      const segName = data.replace("report_seg_", "");
      const { data: rows, error } = await supabase
        .from("data_survey")
        .select("designator, nilai_material, nilai_jasa, total")
        .eq("segmentasi", segName);

      if (error || !rows?.length)
        return bot.sendMessage(chatId, "Tidak ada data untuk segmentasi ini.");

      let msg = `📊 *REPORT*\n${segName.toUpperCase()}\n\n`;
      for (const d of rows) {
        const mat = d.nilai_material ? `Rp${Number(d.nilai_material).toLocaleString("id-ID")}` : "-";
        const jas = d.nilai_jasa ? `Rp${Number(d.nilai_jasa).toLocaleString("id-ID")}` : "-";
        const tot = d.total ? `Rp${Number(d.total).toLocaleString("id-ID")}` : "-";
        msg += `🔧 *${d.designator}*\n📦 Material: ${mat}\n🧰 Jasa: ${jas}\n💰 Total: *${tot}*\n\n`;
      }

      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    }

    // ---------------- MENU INFO ----------------
    else if (data === "menu_info") {
      const { data: cats, error } = await supabase
        .from("designator")
        .select("category")
        .neq("category", null);

      if (error || !cats?.length)
        return bot.sendMessage(chatId, "❌ Tidak ada kategori.");

      const unique = [...new Set(cats.map((c) => c.category))];
      const buttons = unique.map((c) => [
        { text: c, callback_data: `info_cat_${encodeURIComponent(c)}` },
      ]);

      await bot.sendMessage(chatId, "Pilih kategori:", {
        reply_markup: { inline_keyboard: buttons },
      });
    }

    else if (data.startsWith("info_cat_")) {
      const cat = decodeURIComponent(data.replace("info_cat_", ""));
      const { data: desList, error } = await supabase
        .from("designator")
        .select("designator")
        .eq("category", cat);

      if (error || !desList?.length)
        return bot.sendMessage(chatId, "Tidak ada designator.");

      const buttons = desList.map((d) => [
        { text: d.designator, callback_data: `info_des_${encodeURIComponent(d.designator)}` },
      ]);

      await bot.sendMessage(chatId, `Kategori: *${cat}*`, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons },
      });
    }

    else if (data.startsWith("info_des_")) {
      const des = decodeURIComponent(data.replace("info_des_", ""));
      const { data: d, error } = await supabase
        .from("designator")
        .select("uraian_pekerjaan, satuan, nilai_material, nilai_jasa")
        .eq("designator", des)
        .single();

      if (error || !d)
        return bot.sendMessage(chatId, "❌ Designator tidak ditemukan.");

      const mat = d.nilai_material ? `Rp${Number(d.nilai_material).toLocaleString("id-ID")}` : "-";
      const jas = d.nilai_jasa ? `Rp${Number(d.nilai_jasa).toLocaleString("id-ID")}` : "-";
      const total = `Rp${Number((d.nilai_material || 0) + (d.nilai_jasa || 0)).toLocaleString("id-ID")}`;

      await bot.sendMessage(
        chatId,
        `📘 *DETAIL DESIGNATOR*\n\n🔧 ${des}\n📏 Satuan: ${d.satuan || "-"}\n📝 ${d.uraian_pekerjaan || "-"}\n📦 Material: ${mat}\n🧰 Jasa: ${jas}\n💰 Total: *${total}*`,
        { parse_mode: "Markdown" }
      );
    }

    else {
      await bot.sendMessage(chatId, "Gunakan /start untuk memulai ulang.");
    }
  } catch (err) {
    console.error("❌ Callback error:", err);
    await bot.sendMessage(chatId, "Terjadi kesalahan sistem. Coba lagi nanti.");
  }
});
