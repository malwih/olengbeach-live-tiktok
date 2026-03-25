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

const TIKTOK_USERNAMES = String(process.env.TIKTOK_USERNAMES || "")
  .split(",")
  .map((x) => x.trim().replace(/^@/, ""))
  .filter(Boolean);

const CHECK_INTERVAL_SECONDS = Number(process.env.CHECK_INTERVAL_SECONDS || 30);
const MENTION_EVERYONE =
  String(process.env.MENTION_EVERYONE || "true").toLowerCase() === "true";

const SERVER_NAME = process.env.SERVER_NAME || "OLENG BEACH";
const LIVE_BG_URL =
  process.env.LIVE_BG_URL ||
  "https://images.unsplash.com/photo-1511512578047-dfb367046420?q=80&w=1600&auto=format&fit=crop";

// berapa kali poll offline berturut-turut sebelum dianggap benar-benar selesai
const OFFLINE_CONFIRM_TICKS = Number(process.env.OFFLINE_CONFIRM_TICKS || 2);

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN");
if (!GUILD_ID) throw new Error("Missing GUILD_ID");
if (!LIVE_ANNOUNCE_CHANNEL_ID) throw new Error("Missing LIVE_ANNOUNCE_CHANNEL_ID");
if (!TIKTOK_USERNAMES.length) throw new Error("Missing TIKTOK_USERNAMES");

// ========= CLIENT =========
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
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

    if (nextName) state.displayName = nextName;
    if (nextAvatar) state.avatarUrl = nextAvatar;

    if (state.displayName && state.avatarUrl) break;
  }

  state.liveTitle =
    pickFirstString(
      source?.title,
      source?.description,
      source?.roomInfo?.title,
      source?.data?.title
    ) || state.liveTitle;

  state.viewers =
    source?.stats?.userCount ??
    source?.stats?.viewerCount ??
    source?.stats?.totalUser ??
    source?.viewerCount ??
    source?.total ??
    state.viewers;
}

async function fetchTikTokProfileFallback(username) {
  try {
    const html = await fetchText(getTikTokProfileUrl(username));

    let avatarUrl = null;
    let displayName = null;

    // og:image fallback
    const ogImageMatch = html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
    );
    if (ogImageMatch?.[1]) {
      avatarUrl = normalizeImageUrl(ogImageMatch[1]);
    }

    // title/meta fallback
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    if (titleMatch?.[1]) {
      const raw = titleMatch[1].trim();
      const cleaned = raw.split(" | ")[0]?.trim();
      if (cleaned && !cleaned.startsWith("@")) {
        displayName = cleaned;
      }
    }

    // SIGI_STATE JSON
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
        if (nicknameMatch?.[1]) {
          displayName = displayName || nicknameMatch[1];
        }
      } catch {}
    }

    return {
      avatarUrl: avatarUrl || null,
      displayName: displayName || null,
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

  if (!state.avatarUrl || !state.displayName || state.displayName === state.username) {
    const fallback = await fetchTikTokProfileFallback(state.username);

    if (fallback.displayName) state.displayName = fallback.displayName;
    if (fallback.avatarUrl) state.avatarUrl = fallback.avatarUrl;
  }
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

async function createLiveBanner({ username, displayName, avatarUrl }) {
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

  drawCenteredText(ctx, "LIVE NOW", width / 2, 468, {
    font: `96px ${getFontFamily("bold")}`,
    fillStyle: "#ffffff",
    strokeStyle: "rgba(0,0,0,0.78)",
    lineWidth: 12,
  });

  const safeDisplayName = sanitizeText(displayName || username, 32);
  const nameFont = fitText(ctx, safeDisplayName, 900, 58, 22, "bold");
  drawCenteredText(ctx, safeDisplayName, width / 2, 550, {
    font: `${nameFont}px ${getFontFamily("bold")}`,
    fillStyle: "#f8fafc",
    strokeStyle: "rgba(0,0,0,0.78)",
    lineWidth: 8,
  });

  const handle = `@${sanitizeText(username, 32)}`;
  const handleFont = fitText(ctx, handle, 700, 34, 18, "regular");
  drawCenteredText(ctx, handle, width / 2, 605, {
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
  ctx.moveTo(width / 2 - 185, 640);
  ctx.lineTo(width / 2 + 185, 640);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `28px ${getFontFamily("regular")}`;
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  ctx.fillText("Jangan sampai ketinggalan live-nya!", width / 2, 680);
  ctx.restore();

  return canvas.encode("png");
}

async function createEndLiveBanner({ username, displayName, avatarUrl }) {
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

  drawCenteredText(ctx, "LIVE ENDED", width / 2, 468, {
    font: `90px ${getFontFamily("bold")}`,
    fillStyle: "#ffffff",
    strokeStyle: "rgba(0,0,0,0.78)",
    lineWidth: 12,
  });

  const safeDisplayName = sanitizeText(displayName || username, 32);
  const nameFont = fitText(ctx, safeDisplayName, 900, 58, 22, "bold");
  drawCenteredText(ctx, safeDisplayName, width / 2, 550, {
    font: `${nameFont}px ${getFontFamily("bold")}`,
    fillStyle: "#f8fafc",
    strokeStyle: "rgba(0,0,0,0.78)",
    lineWidth: 8,
  });

  const handle = `@${sanitizeText(username, 32)}`;
  const handleFont = fitText(ctx, handle, 700, 34, 18, "regular");
  drawCenteredText(ctx, handle, width / 2, 605, {
    font: `${handleFont}px ${getFontFamily("regular")}`,
    fillStyle: "rgba(255,255,255,0.92)",
    strokeStyle: "rgba(0,0,0,0.65)",
    lineWidth: 6,
  });

  ctx.save();
  ctx.strokeStyle = "#9ca3af";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(width / 2 - 185, 640);
  ctx.lineTo(width / 2 + 185, 640);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `28px ${getFontFamily("regular")}`;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillText("Live sudah selesai. Sampai jumpa di live berikutnya!", width / 2, 680);
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
    `**Nama:** ${state.displayName || state.username}`,
    `**Username:** [@${state.username}](${getTikTokUrl(state.username)})`,
    state.roomId ? `**Room ID:** \`${state.roomId}\`` : null,
    state.viewers != null ? `**Viewer:** ${state.viewers}` : null,
    "",
    state.liveTitle ? `**Judul Live:** ${state.liveTitle}` : "🔴 **Sedang LIVE sekarang**",
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
    `**Nama:** ${state.displayName || state.username}`,
    `**Username:** [@${state.username}](${getTikTokUrl(state.username)})`,
    state.roomId ? `**Room ID:** \`${state.roomId}\`` : null,
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
        .setURL(getTikTokUrl(state.username))
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

  const bannerBuffer = await createLiveBanner({
    username: state.username,
    displayName: state.displayName || state.username,
    avatarUrl: state.avatarUrl,
  });

  const bannerAttachment = new AttachmentBuilder(bannerBuffer, {
    name: `tiktok-live-${state.username}-${Date.now()}.png`,
  });

  await sendAndPublish(channel, {
    content: MENTION_EVERYONE
      ? `🚨 @everyone\n🔴 **${state.displayName || state.username}** sedang LIVE di TikTok!`
      : `🔴 **${state.displayName || state.username}** sedang LIVE di TikTok!`,
    files: [bannerAttachment],
    embeds: [buildLiveEmbed(state)],
    components: buildButtons(state),
    allowedMentions: MENTION_EVERYONE ? { parse: ["everyone"] } : {},
  });
}

async function sendEndLiveAnnouncement(state) {
  const channel = await getAnnounceChannel();
  await hydrateProfile(state);

  const bannerBuffer = await createEndLiveBanner({
    username: state.username,
    displayName: state.displayName || state.username,
    avatarUrl: state.avatarUrl,
  });

  const bannerAttachment = new AttachmentBuilder(bannerBuffer, {
    name: `tiktok-ended-${state.username}-${Date.now()}.png`,
  });

  await sendAndPublish(channel, {
    content: `⏹️ **${state.displayName || state.username}** sudah selesai LIVE di TikTok.`,
    files: [bannerAttachment],
    embeds: [buildEndLiveEmbed(state)],
    components: buildButtons(state),
  });
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

  try {
    state.conn.disconnect();
  } catch {}
}

async function announceLiveIfNeeded(state) {
  if (state.liveMessageSent) return;

  try {
    await sendLiveAnnouncement(state);
    state.liveMessageSent = true;
    state.announcedLive = true;
    console.log(`[${state.username}] live announcement sent`);
  } catch (err) {
    console.error(`[${state.username}] failed live announcement:`, err);
  }
}

async function announceEndIfNeeded(state) {
  if (state.endAnnounced) return;

  try {
    await sendEndLiveAnnouncement(state);
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