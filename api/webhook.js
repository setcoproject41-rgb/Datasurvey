// api/webhook.js
import TelegramBot from "node-telegram-bot-api";
import { supabase } from "../supabaseClient.js";

// --- Setup BOT dalam mode webhook (WAJIB untuk Vercel) ---
const bot = new TelegramBot(process.env.BOT_TOKEN, { webHook: true });
const WEBHOOK_URL = `https://${process.env.VERCEL_URL}/api/webhook`;

// Daftarkan webhook ke Telegram
try {
  await bot.setWebHook(WEBHOOK_URL);
  console.log("✅ Webhook registered at:", WEBHOOK_URL);
} catch (e) {
  console.error("❌ Failed to set webhook:", e.message);
}

// State per pengguna
const userState = {};

// --- Handler utama API (dipanggil oleh Telegram webhook) ---
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("OK");
  try {
    await bot.processUpdate(req.body);
    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Handler error:", err);
    res.status(500).send("Error");
  }
}

// ============================================================
// ==================== LOGIKA BOT MULAI ======================
// ============================================================

// ===== Command /start =====
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
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
    chatId,
    `👋 Selamat datang di *Bot Pelaporan Survey Lapangan!*\n\nSilakan pilih menu:`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
});

// ===== Callback Query Handler =====
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  try {
    // ---------------- MENU LAPORAN ----------------
    if (data === "menu_laporan") {
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
    }

    // Pilih segmentasi
    else if (data.startsWith("seg_")) {
      const segId = data.replace("seg_", "");

      const { data: seg, error } = await supabase
        .from("segmentasi")
        .select("nama_segmentasi")
        .eq("id", segId)
        .single();

      if (error || !seg) return bot.sendMessage(chatId, "❌ Gagal ambil segmentasi.");

      userState[chatId] = { segmentasi: seg.nama_segmentasi };

      const { data: catList, error: catErr } = await supabase
        .from("designator")
        .select("category")
        .not("category", "is", null);

      if (catErr || !catList?.length)
        return bot.sendMessage(chatId, "❌ Tidak ada kategori.");

      const categories = [...new Set(catList.map((c) => c.category))];
      const buttons = categories.map((c) => [
        { text: c, callback_data: `cat_${encodeURIComponent(c)}` },
      ]);

      await bot.sendMessage(
        chatId,
        `📍 Segmentasi *${seg.nama_segmentasi}* dipilih.\nPilih category:`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }
      );
    }

    // Pilih kategori
    else if (data.startsWith("cat_")) {
      const category = decodeURIComponent(data.replace("cat_", ""));
      if (!userState[chatId]) userState[chatId] = {};
      userState[chatId].category = category;

      const { data: desList, error } = await supabase
        .from("designator")
        .select("designator")
        .eq("category", category);

      if (error || !desList?.length)
        return bot.sendMessage(chatId, "❌ Tidak ada designator di kategori ini.");

      const buttons = desList.map((d) => [
        { text: d.designator, callback_data: `lapor_des_${encodeURIComponent(d.designator)}` },
      ]);

      await bot.sendMessage(
        chatId,
        `📦 Kategori *${category}* dipilih.\nPilih designator:`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }
      );
    }

    // Pilih designator untuk laporan
    else if (data.startsWith("lapor_des_")) {
      const designator = decodeURIComponent(data.replace("lapor_des_", ""));
      const seg = userState[chatId]?.segmentasi;
      if (!seg) return bot.sendMessage(chatId, "⚠️ Pilih segmentasi dahulu.");

      const folder = `${seg}/${designator}`;
      const { data: draft, error: insErr } = await supabase
        .from("data_survey")
        .insert([
          {
            telegram_user_id: chatId,
            segmentasi: seg,
            designator,
            folder_path: folder,
            created_at: new Date(),
            total: 0,
          },
        ])
        .select("id")
        .single();

      if (insErr) {
        console.error(insErr);
        return bot.sendMessage(chatId, "❌ Gagal membuat draft laporan.");
      }

      userState[chatId] = {
        ...userState[chatId],
        draft_id: draft.id,
        designator,
        folder_path: folder,
        foto_urls: [],
      };

      await bot.sendMessage(chatId, "📸 Kirim foto eviden pekerjaan.");
    }

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
