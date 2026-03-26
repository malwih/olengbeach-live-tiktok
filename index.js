import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  AttachmentBuilder,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  PermissionsBitField,
} from "discord.js";
import {
  TikTokLiveConnection,
  ControlEvent,
  WebcastEvent,
} from "tiktok-live-connector";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";

// ========= PATH =========
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========= REGISTER FONTS =========
const regularFontPath = path.join(__dirname, "assets/fonts/Poppins-Regular.ttf");
const boldFontPath = path.join(__dirname, "assets/fonts/Poppins-Bold.ttf");

try {
  GlobalFonts.registerFromPath(regularFontPath, "Poppins");
  GlobalFonts.registerFromPath(boldFontPath, "Poppins Bold");
  console.log("Fonts registered:", GlobalFonts.families);
} catch (e) {
  console.warn("Font register skipped:", e?.message || e);
}

// ========= CONFIG =========
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const LIVE_ANNOUNCE_CHANNEL_ID = process.env.LIVE_ANNOUNCE_CHANNEL_ID;
const TIKTOK_TICKET_CATEGORY_ID = process.env.TIKTOK_TICKET_CATEGORY_ID;

const TIKTOK_USERNAMES = String(process.env.TIKTOK_USERNAMES || "")
  .split(",")
  .map((x) => x.trim().replace(/^@/, ""))
  .filter(Boolean);

const CHECK_INTERVAL_SECONDS = Number(process.env.CHECK_INTERVAL_SECONDS || 10);
const MENTION_EVERYONE =
  String(process.env.MENTION_EVERYONE || "true").toLowerCase() === "true";

const SERVER_NAME = process.env.SERVER_NAME || "OLENG BEACH";
const LIVE_BG_URL =
  process.env.LIVE_BG_URL ||
  "https://images.unsplash.com/photo-1511512578047-dfb367046420?q=80&w=1600&auto=format&fit=crop";

// berapa kali poll offline berturut-turut sebelum dianggap benar-benar selesai
const OFFLINE_CONFIRM_TICKS = Number(process.env.OFFLINE_CONFIRM_TICKS || 2);

// live title wajib mengandung semua keyword ini supaya boleh di-broadcast
const REQUIRED_LIVE_TITLE_KEYWORDS = String(
  process.env.REQUIRED_LIVE_TITLE_KEYWORDS || "oleng beach"
)
  .split(" ")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN");
if (!GUILD_ID) throw new Error("Missing GUILD_ID");
if (!LIVE_ANNOUNCE_CHANNEL_ID) throw new Error("Missing LIVE_ANNOUNCE_CHANNEL_ID");
if (!TIKTOK_USERNAMES.length) throw new Error("Missing TIKTOK_USERNAMES");
if (!TIKTOK_TICKET_CATEGORY_ID) throw new Error("Missing TIKTOK_TICKET_CATEGORY_ID");

// ========= CLIENT =========
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// ========= STATE =========
const liveStates = new Map();

function nowIso() {
  return new Date().toISOString();
}

function fmtDateID(dateLike) {
  return new Date(dateLike).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
  });
}

function getTikTokUrl(username) {
  return `https://www.tiktok.com/@${username}/live`;
}

function getTikTokProfileUrl(username) {
  return `https://www.tiktok.com/@${username}`;
}

function getFontFamily(weight = "regular") {
  return weight === "bold" ? '"Poppins Bold", sans-serif' : '"Poppins", sans-serif';
}

function sanitizeText(text, max = 40) {
  return String(text || "")
    .replace(/[`*_~|>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function fitText(ctx, text, maxWidth, startSize = 64, minSize = 18, weight = "bold") {
  let size = startSize;
  const family = getFontFamily(weight);

  while (size >= minSize) {
    ctx.font = `${size}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 2;
  }

  return minSize;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function pickFirstUrl(...candidates) {
  for (const item of candidates) {
    if (!item) continue;

    if (typeof item === "string" && item.trim()) return item.trim();

    if (Array.isArray(item)) {
      const found = item.find((x) => typeof x === "string" && x.trim());
      if (found) return found.trim();
    }
  }
  return null;
}

function normalizeImageUrl(url) {
  if (!url) return null;

  let finalUrl = String(url).trim();
  finalUrl = finalUrl.replace(/\\u002F/g, "/").replace(/&amp;/g, "&");

  if (finalUrl.startsWith("//")) finalUrl = `https:${finalUrl}`;
  if (!/^https?:\/\//i.test(finalUrl)) return null;

  return finalUrl;
}

function normalizeSpace(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUsername(text) {
  return String(text || "")
    .trim()
    .replace(/^@+/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function isGenericTikTokTitle(text) {
  const value = normalizeSpace(text).toLowerCase();
  return (
    !value ||
    value === "tiktok" ||
    value === "tiktok - make your day" ||
    value === "make your day" ||
    value.startsWith("tiktok - make your day")
  );
}

function isValidDisplayName(text, username = "") {
  const value = normalizeSpace(text);
  if (!value) return false;
  if (isGenericTikTokTitle(value)) return false;
  if (value.toLowerCase() === String(username || "").toLowerCase()) return false;
  return true;
}

function cleanLiveTitle(text) {
  const value = normalizeSpace(text);
  if (!value) return null;
  if (isGenericTikTokTitle(value)) return null;
  return value;
}

function isAllowedLiveTitle(title) {
  const normalized = normalizeSpace(title).toLowerCase();
  if (!normalized) return false;
  if (!REQUIRED_LIVE_TITLE_KEYWORDS.length) return true;

  return REQUIRED_LIVE_TITLE_KEYWORDS.every((keyword) =>
    normalized.includes(keyword)
  );
}

function buildTicketChannelName(username, userId) {
  const safeUsername =
    normalizeUsername(username).replace(/[^a-z0-9._-]/g, "").slice(0, 40) || "unknown";
  return `livetiktok-${safeUsername}-${String(userId).slice(-4)}`;
}

function parseTicketMeta(channelTopic = "") {
  const meta = {
    type: null,
    username: null,
    requesterId: null,
    status: null,
    doneAt: null,
  };

  const chunks = String(channelTopic || "").split("|").map((x) => x.trim());
  for (const part of chunks) {
    const [key, ...rest] = part.split("=");
    if (!key) continue;
    meta[key] = rest.join("=");
  }

  return meta;
}

function buildTicketMeta(meta = {}) {
  return [
    `type=${meta.type || "livetiktok"}`,
    `username=${meta.username || ""}`,
    `requesterId=${meta.requesterId || ""}`,
    `status=${meta.status || "open"}`,
    `doneAt=${meta.doneAt || ""}`,
  ].join(" | ");
}

function canManageTicket(member, channel) {
  if (!member || !channel) return false;

  const perms = channel.permissionsFor(member);
  if (!perms) return false;

  return (
    perms.has(PermissionsBitField.Flags.ManageChannels) ||
    perms.has(PermissionsBitField.Flags.ManageMessages) ||
    perms.has(PermissionsBitField.Flags.Administrator)
  );
}

function buildTermsEmbed(username) {
  return new EmbedBuilder()
    .setColor(0xfe2c55)
    .setTitle("📝 Daftar TikTok Live Broadcast")
    .setDescription(
      [
        `**Username TikTok:** \`${username}\``,
        "",
        "**S&K Daftar TikTok Live Broadcast:**",
        '1. Judul / Deskripsi live harus menggunakan kata **"OLENG BEACH"**. Jika tidak, maka live kamu tidak akan di broadcast.',
        "2. Gunakan **username TikTok**. Jika ada perubahan username, kalian wajib menghubungi Owner untuk di Update.",
        "3. Jaga nama baik Oleng Beach saat Live berlangsung. Apabila terindikasi atau laporan penyalahgunaan nama Oleng Beach maka akan di tindaklanjuti dengan tegas.",
        "",
        "Silakan klik **Saya Setuju**, lalu klik **Submit**.",
      ].join("\n")
    )
    .setFooter({ text: `Diajukan pada ${fmtDateID(nowIso())} WIB` })
    .setTimestamp();
}

function buildTermsButtons(username, agreed = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`livetiktok_agree:${username}`)
        .setLabel(agreed ? "✅ Sudah Setuju" : "☑️ Saya Setuju")
        .setStyle(agreed ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`livetiktok_submit:${username}:${agreed ? "1" : "0"}`)
        .setLabel("✅ Submit")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`livetiktok_cancel:${username}`)
        .setLabel("❌ Cancel")
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

function buildTicketButtons(username) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`copy_username:${username}`)
        .setLabel("📋 Copy Username")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`close_ticket:${username}`)
        .setLabel("🔒 Close Ticket")
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("done")
      .setDescription("Selesaikan proses ticket tertentu")
      .addSubcommand((sub) =>
        sub
          .setName("livetiktok")
          .setDescription("Tandai ticket pendaftaran TikTok Live sebagai selesai")
      ),
  ].map((cmd) => cmd.toJSON());

  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.commands.set(commands);
  console.log("Slash commands registered");
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      pragma: "no-cache",
      "cache-control": "no-cache",
      referer: "https://www.google.com/",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }

  return await res.text();
}

async function fetchImageBuffer(url) {
  const normalized = normalizeImageUrl(url);
  if (!normalized) throw new Error("Invalid image url");

  const res = await fetch(normalized, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      referer: "https://www.tiktok.com/",
      origin: "https://www.tiktok.com",
      "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      pragma: "no-cache",
      "cache-control": "no-cache",
    },
  });

  if (!res.ok) {
    throw new Error(`Image request failed with status ${res.status}`);
  }

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function extractUserLikeAvatar(userLike) {
  if (!userLike) return null;

  return pickFirstUrl(
    userLike?.avatarThumb?.urlList,
    userLike?.avatarMedium?.urlList,
    userLike?.avatarLarge?.urlList,
    userLike?.avatarLarger?.urlList,
    userLike?.avatar?.urlList,
    userLike?.avatar_thumb?.url_list,
    userLike?.avatar_medium?.url_list,
    userLike?.avatar_large?.url_list,
    userLike?.avatar_larger?.url_list,
    userLike?.avatarUrl,
    userLike?.avatar_url,
    userLike?.avatarUri,
    userLike?.avatar_uri,
    userLike?.profilePictureUrl,
    userLike?.profile_picture_url
  );
}

function extractProfileFromAny(state, source) {
  if (!source) return;

  const possibleUsers = [
    source?.owner,
    source?.host,
    source?.user,
    source?.userInfo,
    source?.anchor,
    source?.broadcaster,
    source?.ownerInfo,
    source?.hostInfo,
    source?.roomInfo?.owner,
    source?.roomInfo?.host,
    source?.roomInfo?.user,
    source?.roomInfo?.userInfo,
    source?.data?.owner,
    source?.data?.user,
  ].filter(Boolean);

  for (const user of possibleUsers) {
    const nextName = pickFirstString(
      user?.nickname,
      user?.displayName,
      user?.uniqueId,
      user?.unique_id
    );

    const nextAvatar = normalizeImageUrl(extractUserLikeAvatar(user));

    if (isValidDisplayName(nextName, state.username)) {
      state.displayName = nextName;
    }
    if (nextAvatar) {
      state.avatarUrl = nextAvatar;
    }

    if (state.displayName && state.avatarUrl) break;
  }

  const nextLiveTitle = cleanLiveTitle(
    pickFirstString(
      source?.title,
      source?.description,
      source?.roomInfo?.title,
      source?.data?.title,
      source?.owner?.roomTitle,
      source?.user?.roomTitle
    )
  );

  if (nextLiveTitle) {
    state.liveTitle = nextLiveTitle;
  }

  state.viewers =
    source?.stats?.userCount ??
    source?.stats?.viewerCount ??
    source?.stats?.totalUser ??
    source?.viewerCount ??
    source?.total ??
    state.viewers;

  updateBroadcastEligibility(state);
}

async function fetchTikTokProfileFallback(username) {
  try {
    const html = await fetchText(getTikTokProfileUrl(username));

    let avatarUrl = null;
    let displayName = null;

    const ogImageMatch = html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
    );
    if (ogImageMatch?.[1]) {
      avatarUrl = normalizeImageUrl(ogImageMatch[1]);
    }

    const sigiMatch = html.match(
      /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/s
    );

    if (sigiMatch?.[1]) {
      try {
        const jsonText = sigiMatch[1];
        const data = JSON.parse(jsonText);
        const whole = JSON.stringify(data);

        const avatarCandidates = [
          ...whole.matchAll(/"avatarLarger":"(https?:[^"]+)"/g),
          ...whole.matchAll(/"avatarLarge":"(https?:[^"]+)"/g),
          ...whole.matchAll(/"avatarMedium":"(https?:[^"]+)"/g),
          ...whole.matchAll(/"avatarThumb":"(https?:[^"]+)"/g),
          ...whole.matchAll(/"avatar":"(https?:[^"]+)"/g),
        ].map((m) => normalizeImageUrl(m[1]));

        avatarUrl = avatarUrl || avatarCandidates.find(Boolean) || null;

        const nicknameMatch = whole.match(/"nickname":"([^"]+)"/);
        if (nicknameMatch?.[1] && isValidDisplayName(nicknameMatch[1], username)) {
          displayName = nicknameMatch[1];
        }
      } catch {}
    }

    return {
      avatarUrl: avatarUrl || null,
      displayName: isValidDisplayName(displayName, username) ? displayName : null,
    };
  } catch (err) {
    console.warn(`[${username}] profile fallback failed:`, err?.message || err);
    return {
      avatarUrl: null,
      displayName: null,
    };
  }
}

async function hydrateProfile(state) {
  await fetchRoomData(state);

  if (!state.avatarUrl || !isValidDisplayName(state.displayName, state.username)) {
    const fallback = await fetchTikTokProfileFallback(state.username);

    if (fallback.displayName) state.displayName = fallback.displayName;
    if (fallback.avatarUrl) state.avatarUrl = fallback.avatarUrl;
  }

  if (!isValidDisplayName(state.displayName, state.username)) {
    state.displayName = state.username;
  }

  updateBroadcastEligibility(state);
}

async function safeLoadImage(url, width = 1280, height = 720, fallbackType = "bg") {
  try {
    if (!url) throw new Error("Empty image url");
    const buffer = await fetchImageBuffer(url);
    return await loadImage(buffer);
  } catch (error) {
    console.warn("safeLoadImage fallback:", error?.message || error);

    const fallback = createCanvas(width, height);
    const ctx = fallback.getContext("2d");

    if (fallbackType === "avatar") {
      const grad = ctx.createLinearGradient(0, 0, width, height);
      grad.addColorStop(0, "#111827");
      grad.addColorStop(1, "#374151");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `96px ${getFontFamily("bold")}`;
      ctx.fillText("?", width / 2, height / 2 + 6);
      return fallback;
    }

    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, "#111827");
    grad.addColorStop(0.5, "#0f172a");
    grad.addColorStop(1, "#020617");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    return fallback;
  }
}

function drawBadge(ctx, text, x, y, fill = "rgba(255,255,255,0.14)") {
  ctx.save();
  ctx.font = `24px ${getFontFamily("bold")}`;
  const paddingX = 18;
  const boxH = 46;
  const textWidth = ctx.measureText(text).width;
  const boxW = textWidth + paddingX * 2;

  ctx.fillStyle = fill;
  roundRect(ctx, x, y, boxW, boxH, 14);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + paddingX, y + boxH / 2 + 1);
  ctx.restore();
}

function drawCenteredText(ctx, text, x, y, options = {}) {
  const {
    font = `60px ${getFontFamily("bold")}`,
    fillStyle = "#ffffff",
    strokeStyle = "rgba(0,0,0,0.75)",
    lineWidth = 8,
  } = options;

  ctx.save();
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = strokeStyle;
  ctx.fillStyle = fillStyle;
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
  ctx.restore();
}

async function createLiveBanner({ username, displayName, avatarUrl, liveTitle }) {
  const width = 1280;
  const height = 720;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const bg = await safeLoadImage(LIVE_BG_URL, width, height, "bg");
  ctx.drawImage(bg, 0, 0, width, height);

  const overlay = ctx.createLinearGradient(0, 0, 0, height);
  overlay.addColorStop(0, "rgba(0,0,0,0.20)");
  overlay.addColorStop(0.55, "rgba(0,0,0,0.45)");
  overlay.addColorStop(1, "rgba(0,0,0,0.82)");
  ctx.fillStyle = overlay;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createLinearGradient(0, 0, width, height);
  glow.addColorStop(0, "rgba(37,244,238,0.10)");
  glow.addColorStop(0.5, "rgba(0,0,0,0)");
  glow.addColorStop(1, "rgba(254,44,85,0.18)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 2;
  roundRect(ctx, 28, 28, width - 56, height - 56, 28);
  ctx.stroke();
  ctx.restore();

  drawBadge(ctx, "TIKTOK LIVE", 55, 52, "rgba(254,44,85,0.22)");

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = `36px ${getFontFamily("bold")}`;
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.fillText(SERVER_NAME, width / 2, 56);
  ctx.restore();

  const avatar = await safeLoadImage(avatarUrl, 512, 512, "avatar");
  const avatarSize = 220;
  const avatarX = width / 2 - avatarSize / 2;
  const avatarY = 132;
  const avatarCenterX = width / 2;
  const avatarCenterY = avatarY + avatarSize / 2;

  ctx.save();
  ctx.shadowColor = "#fe2c55";
  ctx.shadowBlur = 42;
  ctx.beginPath();
  ctx.arc(avatarCenterX, avatarCenterY, avatarSize / 2 + 12, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.10)";
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarCenterX, avatarCenterY, avatarSize / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarCenterX, avatarCenterY, avatarSize / 2 + 6, 0, Math.PI * 2);
  ctx.lineWidth = 10;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.restore();

  drawCenteredText(ctx, "LIVE NOW", width / 2, 460, {
    font: `92px ${getFontFamily("bold")}`,
    fillStyle: "#ffffff",
    strokeStyle: "rgba(0,0,0,0.78)",
    lineWidth: 12,
  });

  const safeTitle = sanitizeText(liveTitle || "Tanpa Judul Live", 52);
  const titleFont = fitText(ctx, safeTitle, 980, 52, 22, "bold");
  drawCenteredText(ctx, safeTitle, width / 2, 530, {
    font: `${titleFont}px ${getFontFamily("bold")}`,
    fillStyle: "#f8fafc",
    strokeStyle: "rgba(0,0,0,0.78)",
    lineWidth: 8,
  });

  const safeDisplayName = sanitizeText(displayName || username, 32);
  const nameFont = fitText(ctx, safeDisplayName, 900, 42, 20, "bold");
  drawCenteredText(ctx, safeDisplayName, width / 2, 585, {
    font: `${nameFont}px ${getFontFamily("bold")}`,
    fillStyle: "#f8fafc",
    strokeStyle: "rgba(0,0,0,0.78)",
    lineWidth: 8,
  });

  const handle = `@${sanitizeText(username, 32)}`;
  const handleFont = fitText(ctx, handle, 700, 30, 18, "regular");
  drawCenteredText(ctx, handle, width / 2, 628, {
    font: `${handleFont}px ${getFontFamily("regular")}`,
    fillStyle: "rgba(255,255,255,0.95)",
    strokeStyle: "rgba(0,0,0,0.65)",
    lineWidth: 6,
  });

  ctx.save();
  const lineGrad = ctx.createLinearGradient(width / 2 - 190, 0, width / 2 + 190, 0);
  lineGrad.addColorStop(0, "#25f4ee");
  lineGrad.addColorStop(1, "#fe2c55");
  ctx.strokeStyle = lineGrad;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(width / 2 - 185, 655);
  ctx.lineTo(width / 2 + 185, 655);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `28px ${getFontFamily("regular")}`;
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  ctx.fillText("Jangan sampai ketinggalan live-nya!", width / 2, 688);
  ctx.restore();

  return canvas.encode("png");
}

async function createEndLiveBanner({ username, displayName, avatarUrl, liveTitle }) {
  const width = 1280;
  const height = 720;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const bg = await safeLoadImage(LIVE_BG_URL, width, height, "bg");
  ctx.drawImage(bg, 0, 0, width, height);

  const overlay = ctx.createLinearGradient(0, 0, 0, height);
  overlay.addColorStop(0, "rgba(0,0,0,0.30)");
  overlay.addColorStop(0.55, "rgba(0,0,0,0.55)");
  overlay.addColorStop(1, "rgba(0,0,0,0.88)");
  ctx.fillStyle = overlay;
  ctx.fillRect(0, 0, width, height);

  const grayGlow = ctx.createLinearGradient(0, 0, width, height);
  grayGlow.addColorStop(0, "rgba(255,255,255,0.05)");
  grayGlow.addColorStop(1, "rgba(120,120,120,0.14)");
  ctx.fillStyle = grayGlow;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 2;
  roundRect(ctx, 28, 28, width - 56, height - 56, 28);
  ctx.stroke();
  ctx.restore();

  drawBadge(ctx, "LIVE ENDED", 55, 52, "rgba(160,160,160,0.20)");

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = `36px ${getFontFamily("bold")}`;
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.fillText(SERVER_NAME, width / 2, 56);
  ctx.restore();

  const avatar = await safeLoadImage(avatarUrl, 512, 512, "avatar");
  const avatarSize = 220;
  const avatarX = width / 2 - avatarSize / 2;
  const avatarY = 132;
  const avatarCenterX = width / 2;
  const avatarCenterY = avatarY + avatarSize / 2;

  ctx.save();
  ctx.shadowColor = "#9ca3af";
  ctx.shadowBlur = 38;
  ctx.beginPath();
  ctx.arc(avatarCenterX, avatarCenterY, avatarSize / 2 + 12, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarCenterX, avatarCenterY, avatarSize / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarCenterX, avatarCenterY, avatarSize / 2 + 6, 0, Math.PI * 2);
  ctx.lineWidth = 10;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.restore();

  drawCenteredText(ctx, "LIVE ENDED", width / 2, 460, {
    font: `86px ${getFontFamily("bold")}`,
    fillStyle: "#ffffff",
    strokeStyle: "rgba(0,0,0,0.78)",
    lineWidth: 12,
  });

  const safeTitle = sanitizeText(liveTitle || "Tanpa Judul Live", 52);
  const titleFont = fitText(ctx, safeTitle, 980, 50, 22, "bold");
  drawCenteredText(ctx, safeTitle, width / 2, 530, {
    font: `${titleFont}px ${getFontFamily("bold")}`,
    fillStyle: "#f8fafc",
    strokeStyle: "rgba(0,0,0,0.78)",
    lineWidth: 8,
  });

  const safeDisplayName = sanitizeText(displayName || username, 32);
  const nameFont = fitText(ctx, safeDisplayName, 900, 42, 20, "bold");
  drawCenteredText(ctx, safeDisplayName, width / 2, 585, {
    font: `${nameFont}px ${getFontFamily("bold")}`,
    fillStyle: "#f8fafc",
    strokeStyle: "rgba(0,0,0,0.78)",
    lineWidth: 8,
  });

  const handle = `@${sanitizeText(username, 32)}`;
  const handleFont = fitText(ctx, handle, 700, 30, 18, "regular");
  drawCenteredText(ctx, handle, width / 2, 628, {
    font: `${handleFont}px ${getFontFamily("regular")}`,
    fillStyle: "rgba(255,255,255,0.92)",
    strokeStyle: "rgba(0,0,0,0.65)",
    lineWidth: 6,
  });

  ctx.save();
  ctx.strokeStyle = "#9ca3af";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(width / 2 - 185, 655);
  ctx.lineTo(width / 2 + 185, 655);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `28px ${getFontFamily("regular")}`;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillText("Live sudah selesai. Sampai jumpa di live berikutnya!", width / 2, 688);
  ctx.restore();

  return canvas.encode("png");
}

function createState(username) {
  const conn = new TikTokLiveConnection(username);

  const state = {
    username,
    conn,

    isLive: false,
    isConnecting: false,
    announcedLive: false,
    endAnnounced: false,
    liveMessageSent: false,
    roomId: null,
    lastLiveAt: null,
    lastEndedAt: null,

    displayName: username,
    avatarUrl: null,
    liveTitle: null,
    viewers: null,

    lastPollLive: false,
    offlineTicks: 0,
    activeSessionId: null,

    shouldBroadcastLive: false,
    hasBroadcastedLive: false,
  };

  bindTikTokEvents(state);
  return state;
}

function getState(username) {
  if (!liveStates.has(username)) {
    liveStates.set(username, createState(username));
  }
  return liveStates.get(username);
}

function updateBroadcastEligibility(state) {
  state.shouldBroadcastLive = isAllowedLiveTitle(state.liveTitle);
}

async function fetchRoomData(state) {
  try {
    const roomInfo = await state.conn.fetchRoomInfo();
    extractProfileFromAny(state, roomInfo);
    return roomInfo;
  } catch (err) {
    console.warn(`[${state.username}] fetchRoomInfo failed:`, err?.message || err);
    return null;
  }
}

function buildLiveEmbed(state) {
  const lines = [
    `**Nama Profil:** ${state.displayName || state.username}`,
    `**Username:** [@${state.username}](${getTikTokUrl(state.username)})`,
    state.roomId ? `**Room ID:** \`${state.roomId}\`` : null,
    state.viewers != null ? `**Viewer:** ${state.viewers}` : null,
    state.liveTitle ? `**Judul Live:** ${state.liveTitle}` : `**Judul Live:** Tidak terdeteksi`,
    "",
    "🔴 **Sedang LIVE sekarang**",
    "",
    "Klik tombol di bawah untuk langsung masuk ke TikTok LIVE.",
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(0xfe2c55)
    .setTitle("🔴 TikTok LIVE Terdeteksi")
    .setDescription(lines.join("\n"))
    .setURL(getTikTokUrl(state.username))
    .setFooter({ text: `Detected at ${fmtDateID(nowIso())} WIB` })
    .setTimestamp();

  if (state.avatarUrl) {
    embed.setThumbnail(state.avatarUrl);
  }

  return embed;
}

function buildEndLiveEmbed(state) {
  const lines = [
    `**Nama Profil:** ${state.displayName || state.username}`,
    `**Username:** [@${state.username}](${getTikTokUrl(state.username)})`,
    state.roomId ? `**Room ID:** \`${state.roomId}\`` : null,
    state.liveTitle ? `**Judul Live Terakhir:** ${state.liveTitle}` : null,
    "",
    "Live barusan sudah berakhir.",
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(0x9ca3af)
    .setTitle("⏹️ TikTok LIVE Selesai")
    .setDescription(lines.join("\n"))
    .setURL(getTikTokUrl(state.username))
    .setFooter({ text: `Ended at ${fmtDateID(nowIso())} WIB` })
    .setTimestamp();

  if (state.avatarUrl) {
    embed.setThumbnail(state.avatarUrl);
  }

  return embed;
}

function buildButtons(state) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("🎥 Buka TikTok")
        .setStyle(ButtonStyle.Link)
        .setURL(getTikTokUrl(state.username)),
      new ButtonBuilder()
        .setCustomId(`register_tiktok_live:${state.username}`)
        .setLabel("📝 Daftarkan TikTok Live Saya")
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

async function getAnnounceChannel() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(LIVE_ANNOUNCE_CHANNEL_ID);

  if (!channel) throw new Error("LIVE_ANNOUNCE_CHANNEL_ID not found");

  if (
    channel.type !== ChannelType.GuildText &&
    channel.type !== ChannelType.GuildAnnouncement
  ) {
    throw new Error("LIVE_ANNOUNCE_CHANNEL_ID must be text/announcement channel");
  }

  return channel;
}

async function sendAndPublish(channel, payload) {
  const message = await channel.send(payload);

  if (channel.type === ChannelType.GuildAnnouncement) {
    try {
      await message.crosspost();
      console.log(`[channel:${channel.id}] published`);
    } catch (err) {
      console.warn(`[channel:${channel.id}] crosspost failed:`, err?.message || err);
    }
  }

  return message;
}

async function sendLiveAnnouncement(state) {
  const channel = await getAnnounceChannel();
  await hydrateProfile(state);

  if (!state.shouldBroadcastLive) {
    console.log(
      `[${state.username}] live skipped: title does not match filter -> ${state.liveTitle || "-"}`
    );
    return false;
  }

  const bannerBuffer = await createLiveBanner({
    username: state.username,
    displayName: state.displayName || state.username,
    avatarUrl: state.avatarUrl,
    liveTitle: state.liveTitle,
  });

  const bannerAttachment = new AttachmentBuilder(bannerBuffer, {
    name: `tiktok-live-${state.username}-${Date.now()}.png`,
  });

  await sendAndPublish(channel, {
    content: MENTION_EVERYONE
      ? `🚨 @everyone\n🔴 **${state.displayName || state.username}** sedang LIVE di TikTok!\n**Judul:** ${state.liveTitle || "Tidak terdeteksi"}`
      : `🔴 **${state.displayName || state.username}** sedang LIVE di TikTok!\n**Judul:** ${state.liveTitle || "Tidak terdeteksi"}`,
    files: [bannerAttachment],
    embeds: [buildLiveEmbed(state)],
    components: buildButtons(state),
    allowedMentions: MENTION_EVERYONE ? { parse: ["everyone"] } : {},
  });

  return true;
}

async function sendEndLiveAnnouncement(state) {
  const channel = await getAnnounceChannel();
  await hydrateProfile(state);

  if (!state.hasBroadcastedLive) {
    console.log(
      `[${state.username}] end skipped: session was never broadcasted`
    );
    return false;
  }

  const bannerBuffer = await createEndLiveBanner({
    username: state.username,
    displayName: state.displayName || state.username,
    avatarUrl: state.avatarUrl,
    liveTitle: state.liveTitle,
  });

  const bannerAttachment = new AttachmentBuilder(bannerBuffer, {
    name: `tiktok-ended-${state.username}-${Date.now()}.png`,
  });

  await sendAndPublish(channel, {
    content: `⏹️ **${state.displayName || state.username}** sudah selesai LIVE di TikTok.\n**Judul terakhir:** ${state.liveTitle || "Tidak terdeteksi"}`,
    files: [bannerAttachment],
    embeds: [buildEndLiveEmbed(state)],
    components: buildButtons(state),
  });

  return true;
}

function resetLiveFlagsAfterEnd(state) {
  state.isLive = false;
  state.isConnecting = false;
  state.announcedLive = false;
  state.liveMessageSent = false;
  state.endAnnounced = false;
  state.roomId = null;
  state.liveTitle = null;
  state.viewers = null;
  state.lastEndedAt = nowIso();
  state.activeSessionId = null;
  state.shouldBroadcastLive = false;
  state.hasBroadcastedLive = false;

  try {
    state.conn.disconnect();
  } catch {}
}

async function announceLiveIfNeeded(state) {
  if (state.liveMessageSent) return;
  await hydrateProfile(state);

  if (!state.shouldBroadcastLive) {
    console.log(
      `[${state.username}] live not broadcasted because title doesn't contain required keywords. title="${state.liveTitle || "-"}"`
    );
    return;
  }

  try {
    const sent = await sendLiveAnnouncement(state);
    if (!sent) return;

    state.liveMessageSent = true;
    state.announcedLive = true;
    state.hasBroadcastedLive = true;
    console.log(`[${state.username}] live announcement sent`);
  } catch (err) {
    console.error(`[${state.username}] failed live announcement:`, err);
  }
}

async function announceEndIfNeeded(state) {
  if (state.endAnnounced) return;
  if (!state.hasBroadcastedLive) {
    console.log(`[${state.username}] end not sent because live was not broadcasted`);
    return;
  }

  try {
    const sent = await sendEndLiveAnnouncement(state);
    if (!sent) return;

    state.endAnnounced = true;
    console.log(`[${state.username}] end announcement sent`);
  } catch (err) {
    console.error(`[${state.username}] failed end announcement:`, err);
  }
}

function bindTikTokEvents(state) {
  const { conn, username } = state;

  conn.on(ControlEvent.CONNECTED, async (connState) => {
    state.isConnecting = false;
    state.isLive = true;
    state.offlineTicks = 0;
    state.lastPollLive = true;
    state.roomId = connState?.roomId || state.roomId;
    state.lastLiveAt = state.lastLiveAt || nowIso();
    state.activeSessionId = state.activeSessionId || `${username}:${Date.now()}`;
    state.endAnnounced = false;

    extractProfileFromAny(state, connState);

    console.log(`[${username}] CONNECTED roomId=${state.roomId}`);

    await announceLiveIfNeeded(state);
  });

  conn.on(ControlEvent.DISCONNECTED, ({ code, reason }) => {
    console.log(`[${username}] DISCONNECTED code=${code} reason=${reason || "-"}`);
    state.isConnecting = false;
  });

  conn.on(ControlEvent.ERROR, ({ info, exception }) => {
    console.error(`[${username}] ERROR:`, info || exception || "unknown error");
    state.isConnecting = false;
  });

  conn.on(WebcastEvent.LIVE_INTRO, (msg) => {
    extractProfileFromAny(state, msg);
  });

  conn.on(WebcastEvent.ROOM_USER, (msg) => {
    extractProfileFromAny(state, msg);
  });

  conn.on(WebcastEvent.STREAM_END, async ({ action }) => {
    console.log(`[${username}] STREAM_END action=${action}`);
    await announceEndIfNeeded(state);
    resetLiveFlagsAfterEnd(state);
  });
}

async function ensureLiveConnection(state) {
  if (state.isConnecting || state.isLive) return;

  state.isConnecting = true;

  try {
    const liveNow = await state.conn.fetchIsLive();

    if (!liveNow) {
      state.isConnecting = false;
      return;
    }

    state.lastLiveAt = state.lastLiveAt || nowIso();
    state.activeSessionId = state.activeSessionId || `${state.username}:${Date.now()}`;
    state.offlineTicks = 0;
    state.lastPollLive = true;
    state.isLive = true;

    await hydrateProfile(state);

    try {
      await state.conn.connect();
    } catch (err) {
      console.warn(`[${state.username}] connect stream failed:`, err?.message || err);
    }

    await announceLiveIfNeeded(state);
  } catch (err) {
    state.isConnecting = false;
    console.warn(`[${state.username}] connect failed:`, err?.message || err);
  } finally {
    state.isConnecting = false;
  }
}

async function handlePolledOffline(state) {
  state.offlineTicks += 1;
  state.lastPollLive = false;

  const hadActiveSession =
    state.isLive || state.liveMessageSent || state.announcedLive || !!state.activeSessionId;

  if (!hadActiveSession) {
    resetLiveFlagsAfterEnd(state);
    return;
  }

  if (state.offlineTicks < OFFLINE_CONFIRM_TICKS) {
    console.log(
      `[${state.username}] offline tick ${state.offlineTicks}/${OFFLINE_CONFIRM_TICKS}`
    );
    return;
  }

  console.log(`[${state.username}] confirmed offline, sending end announcement`);
  await announceEndIfNeeded(state);
  resetLiveFlagsAfterEnd(state);
}

async function handlePolledLive(state) {
  state.offlineTicks = 0;
  state.lastPollLive = true;
  state.isLive = true;
  state.lastLiveAt = state.lastLiveAt || nowIso();
  state.activeSessionId = state.activeSessionId || `${state.username}:${Date.now()}`;
  state.endAnnounced = false;

  await hydrateProfile(state);
  await announceLiveIfNeeded(state);

  if (!state.conn.getState || !state.conn.getState()?.isConnected) {
    try {
      await state.conn.connect();
    } catch (err) {
      console.warn(`[${state.username}] reconnect watcher failed:`, err?.message || err);
    }
  }
}

async function sweepTikTokLives() {
  for (const username of TIKTOK_USERNAMES) {
    const state = getState(username);

    try {
      const liveNow = await state.conn.fetchIsLive();
      console.log(`[${username}] poll live=${liveNow}`);

      if (liveNow) {
        await handlePolledLive(state);
      } else {
        await handlePolledOffline(state);
      }
    } catch (err) {
      console.warn(`[${username}] fetchIsLive failed:`, err?.message || err);
    }
  }
}

// ========= TICKET HELPERS =========
async function createLiveTikTokTicket({ guild, requester, username }) {
  const cleanUsername = normalizeUsername(username);

  const channel = await guild.channels.create({
    name: buildTicketChannelName(cleanUsername, requester.id),
    type: ChannelType.GuildText,
    parent: TIKTOK_TICKET_CATEGORY_ID,
    topic: buildTicketMeta({
      type: "livetiktok",
      username: cleanUsername,
      requesterId: requester.id,
      status: "open",
      doneAt: "",
    }),
  });

  // Tambahkan akses khusus user pemohon dan bot.
  // Role staff/admin otomatis ikut permission dari category Discord.
  await channel.permissionOverwrites.edit(requester.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
  });

  await channel.permissionOverwrites.edit(client.user.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    ManageChannels: true,
    ManageMessages: true,
  });

  const embed = new EmbedBuilder()
    .setColor(0xfe2c55)
    .setTitle("🎫 Ticket Pendaftaran TikTok Live")
    .setDescription(
      [
        `**Pemohon:** ${requester}`,
        `**User ID:** \`${requester.id}\``,
        `**Username TikTok:** \`${cleanUsername}\``,
        "",
        "Staff / admin yang memang punya akses di category ini silakan proses ticket.",
        "Jika sudah selesai, jalankan command:",
        "`/done livetiktok`",
      ].join("\n")
    )
    .setFooter({ text: `Created at ${fmtDateID(nowIso())} WIB` })
    .setTimestamp();

  await channel.send({
    content: `${requester}`,
    embeds: [embed],
    components: buildTicketButtons(cleanUsername),
  });

  return channel;
}

async function lockTicketForUser(channel, requesterId) {
  try {
    await channel.permissionOverwrites.edit(requesterId, {
      SendMessages: false,
    });
  } catch (err) {
    console.warn("Failed locking ticket for user:", err?.message || err);
  }
}

async function closeTicketChannel(channel, reason = "Closed") {
  try {
    await channel.send(`🔒 Ticket akan ditutup. Alasan: **${reason}**`);
  } catch {}

  setTimeout(async () => {
    try {
      await channel.delete(`Auto close ticket: ${reason}`);
    } catch (err) {
      console.warn("Failed deleting ticket channel:", err?.message || err);
    }
  }, 5_000).unref();
}

async function scheduleAutoCloseTicket(channel) {
  setTimeout(async () => {
    try {
      const fresh = await channel.guild.channels.fetch(channel.id).catch(() => null);
      if (!fresh) return;

      const meta = parseTicketMeta(fresh.topic || "");
      if (meta.status !== "done") return;

      await fresh.send("⏰ 30 menit telah berlalu. Ticket akan ditutup otomatis.");
      await closeTicketChannel(fresh, "Auto close setelah /done livetiktok");
    } catch (err) {
      console.warn("Failed auto close ticket:", err?.message || err);
    }
  }, 30 * 60 * 1000).unref();
}

// ========= INTERACTIONS =========
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      const parts = String(interaction.customId || "").split(":");
      const action = parts[0];
      const value = parts[1];

      if (action === "register_tiktok_live") {
        const modal = new ModalBuilder()
          .setCustomId(`register_tiktok_live_modal:${value || ""}`)
          .setTitle("Daftarkan TikTok Live Saya");

        const usernameInput = new TextInputBuilder()
          .setCustomId("tiktok_username")
          .setLabel("Masukkan username TikTok")
          .setPlaceholder("contoh: olengbeachlive")
          .setRequired(true)
          .setStyle(TextInputStyle.Short)
          .setMaxLength(50);

        modal.addComponents(
          new ActionRowBuilder().addComponents(usernameInput)
        );

        await interaction.showModal(modal);
        return;
      }

      if (action === "livetiktok_agree") {
        const username = normalizeUsername(value);

        await interaction.update({
          embeds: [buildTermsEmbed(username)],
          components: buildTermsButtons(username, true),
          content: "✅ Kamu sudah menyetujui S&K. Sekarang klik **Submit**.",
        });
        return;
      }

      if (action === "livetiktok_cancel") {
        await interaction.update({
          content: "❌ Pendaftaran dibatalkan.",
          embeds: [],
          components: [],
        });
        return;
      }

      if (action === "livetiktok_submit") {
        const username = normalizeUsername(parts[1]);
        const agreed = parts[2] === "1";

        if (!agreed) {
          await interaction.reply({
            content: "❌ Kamu harus klik **Saya Setuju** dulu sebelum submit.",
            ephemeral: true,
          });
          return;
        }

        if (!username) {
          await interaction.reply({
            content: "❌ Username TikTok tidak valid.",
            ephemeral: true,
          });
          return;
        }

        const guild = interaction.guild;
        const requester = interaction.user;

        const existing = guild.channels.cache.find((ch) => {
          if (ch.type !== ChannelType.GuildText) return false;
          const meta = parseTicketMeta(ch.topic || "");
          return (
            meta.type === "livetiktok" &&
            meta.requesterId === requester.id &&
            meta.username === username &&
            meta.status === "open"
          );
        });

        if (existing) {
          await interaction.reply({
            content: `⚠️ Kamu sudah punya ticket aktif untuk username \`${username}\`: ${existing}`,
            ephemeral: true,
          });
          return;
        }

        const ticketChannel = await createLiveTikTokTicket({
          guild,
          requester,
          username,
        });

        await interaction.update({
          content: `✅ Ticket berhasil dibuat: ${ticketChannel}`,
          embeds: [],
          components: [],
        });
        return;
      }

      if (action === "copy_username") {
        await interaction.reply({
          content: `📋 Username TikTok: \`${value}\``,
          ephemeral: true,
        });
        return;
      }

      if (action === "close_ticket") {
        const member = interaction.member;
        const channel = interaction.channel;

        if (!canManageTicket(member, channel)) {
          await interaction.reply({
            content: "❌ Kamu tidak punya izin untuk menutup ticket ini.",
            ephemeral: true,
          });
          return;
        }

        await interaction.reply({
          content: "🔒 Ticket akan ditutup.",
          ephemeral: true,
        });

        await closeTicketChannel(channel, "Ditutup manual");
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      const [action] = String(interaction.customId || "").split(":");

      if (action === "register_tiktok_live_modal") {
        const username = normalizeUsername(
          interaction.fields.getTextInputValue("tiktok_username")
        );

        if (!username) {
          await interaction.reply({
            content: "❌ Username TikTok tidak valid. Gunakan username, bukan nama profil.",
            ephemeral: true,
          });
          return;
        }

        await interaction.reply({
          ephemeral: true,
          embeds: [buildTermsEmbed(username)],
          components: buildTermsButtons(username, false),
        });
        return;
      }
    }

    if (interaction.isChatInputCommand()) {
      if (
        interaction.commandName === "done" &&
        interaction.options.getSubcommand() === "livetiktok"
      ) {
        const member = interaction.member;
        const channel = interaction.channel;

        if (!canManageTicket(member, channel)) {
          await interaction.reply({
            content: "❌ Kamu tidak punya izin untuk memproses ticket ini.",
            ephemeral: true,
          });
          return;
        }

        const meta = parseTicketMeta(channel.topic || "");
        if (meta.type !== "livetiktok") {
          await interaction.reply({
            content: "❌ Command ini hanya bisa dipakai di channel ticket TikTok Live.",
            ephemeral: true,
          });
          return;
        }

        if (!meta.requesterId) {
          await interaction.reply({
            content: "❌ Data requester ticket tidak ditemukan.",
            ephemeral: true,
          });
          return;
        }

        await channel.setTopic(
          buildTicketMeta({
            type: "livetiktok",
            username: meta.username,
            requesterId: meta.requesterId,
            status: "done",
            doneAt: nowIso(),
          })
        );

        await lockTicketForUser(channel, meta.requesterId);

        await channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x22c55e)
              .setTitle("✅ Pendaftaran TikTok Live Sudah Diproses")
              .setDescription(
                [
                  `Pendaftaran untuk username TikTok \`${meta.username}\` sudah diproses oleh ${interaction.user}.`,
                  "",
                  `<@${meta.requesterId}> sekarang ticket ini telah selesai diproses.`,
                  "Kamu sudah tidak bisa mengirim chat lagi di ticket ini.",
                  "Ticket akan otomatis ditutup dalam **30 menit**.",
                ].join("\n")
              )
              .setTimestamp(),
          ],
          components: buildTicketButtons(meta.username),
        });

        await interaction.reply({
          content:
            "✅ Ticket ditandai selesai, user sudah diberi info, channel dikunci, dan auto close 30 menit dijadwalkan.",
          ephemeral: true,
        });

        await scheduleAutoCloseTicket(channel);
        return;
      }
    }
  } catch (err) {
    console.error("interaction error:", err);

    if (interaction.isRepliable()) {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({
            content: "❌ Terjadi error saat memproses permintaan.",
            ephemeral: true,
          });
        } else {
          await interaction.reply({
            content: "❌ Terjadi error saat memproses permintaan.",
            ephemeral: true,
          });
        }
      } catch {}
    }
  }
});

// ========= START =========
client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Monitoring: ${TIKTOK_USERNAMES.join(", ")}`);

  try {
    await getAnnounceChannel();
    console.log("Announcement channel OK");
  } catch (err) {
    console.error("Announcement channel error:", err);
    process.exit(1);
  }

  try {
    await registerSlashCommands();
  } catch (err) {
    console.error("Slash command register error:", err);
  }

  await sweepTikTokLives();

  setInterval(async () => {
    try {
      await sweepTikTokLives();
    } catch (err) {
      console.error("sweepTikTokLives error:", err);
    }
  }, CHECK_INTERVAL_SECONDS * 1000).unref();
});

client.login(DISCORD_TOKEN);