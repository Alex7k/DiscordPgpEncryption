/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import { ExpressionPickerStore, SelectedChannelStore } from "@webpack/common";

import { mimeFromFilename, sendFilesMessage } from "./attachments";
import { sendEncryptedText } from "./messageHandler";
import { settings } from "./settings";
import { enabledChannels } from "./state";

const logger = new Logger("PgpEncrypt", "#7289da");

// undefined on web builds, where there is no main process to fetch through
const Native = VencordNative.pluginHelpers.PgpEncrypt as PluginNative<typeof import("./native")> | undefined;

/** The picker's gif object; field names vary across Discord versions, all optional */
interface PickedGif {
    url?: string;
    src?: string;
    gifSrc?: string;
    gif_src?: string;
}

/** formats the decrypted-attachment card can render inline */
const MEDIA_EXT_RE = /\.(gif|mp4|webm|webp|png|jpe?g)$/i;

/**
 * GIF CDNs the sender's picker already talked to, plus Discord's own media
 * proxy, which the picker often serves results through (and which is the most
 * private option of all: the recipient contacts Discord regardless).
 */
function isAllowedMediaHost(host: string): boolean {
    return host === "tenor.com" || host.endsWith(".tenor.com")
        || host === "giphy.com" || host.endsWith(".giphy.com")
        || host === "media.discordapp.net" || /^images-ext-\d+\.discordapp\.net$/.test(host);
}

/** Parses a candidate into a URL if it points at media on an allowed host */
function asAllowedMediaUrl(raw: unknown): URL | null {
    if (typeof raw !== "string") return null;
    try {
        const url = new URL(raw);
        if (url.protocol !== "https:" || !isAllowedMediaHost(url.hostname) || !MEDIA_EXT_RE.test(url.pathname)) return null;
        return url;
    } catch {
        return null;
    }
}

/** Best media URL of a picked gif: a real .gif beats the mp4 preview, which beats nothing */
function pickMediaUrl(gif: PickedGif): URL | null {
    const candidates = [gif.gifSrc, gif.gif_src, gif.src, gif.url]
        .map(asAllowedMediaUrl)
        .filter((url): url is URL => url !== null);
    return candidates.find(url => /\.gif$/i.test(url.pathname)) ?? candidates[0] ?? null;
}

/**
 * Patch predicate: convert this gif selection into an encrypted file upload?
 * Cheap and synchronous; every message-send path outside PGP channels must
 * stay untouched. Deliberately does not require the native helper: without it
 * the interception still runs and falls back to an ENCRYPTED link, because the
 * picker's own send path would bypass the encryption hook entirely.
 */
export function shouldSendGifAsFile(): boolean {
    if (!settings.store.gifAsFile || !settings.store.encryptAttachments) return false;
    const channelId = SelectedChannelStore.getChannelId();
    return !!channelId && enabledChannels.has(channelId);
}

/** Replaces the picker's plain-link send. The download and upload run on after the picker closes. */
export function sendGifAsFile(gif: PickedGif) {
    const channelId = SelectedChannelStore.getChannelId();
    ExpressionPickerStore.closeExpressionPicker();
    if (!channelId) return;
    void convertAndSend(channelId, gif);
}

/**
 * When the file conversion cannot happen, send the link like a typed message:
 * through the plugin's encryption, or not at all. Direct MessageActions sends
 * skip the pre-send hook, so plaintext must never be handed to them.
 */
async function fallBackToLink(channelId: string, gif: PickedGif, why: string) {
    logger.warn(`Sending gif as encrypted link instead of file: ${why}. Picker gif object:`, gif);
    showNotification({ title: "PGP Encryption", body: `Could not send the GIF as an encrypted file (${why}); sent it as an encrypted link instead.` });

    const sent = gif.url ? await sendEncryptedText(channelId, gif.url) : false;
    if (!sent) {
        showNotification({ title: "PGP Encryption", body: "The GIF was not sent." });
    }
}

async function convertAndSend(channelId: string, gif: PickedGif) {
    try {
        if (!Native) return await fallBackToLink(channelId, gif, "no native helper on this platform");

        const media = pickMediaUrl(gif);
        if (!media) return await fallBackToLink(channelId, gif, "no recognizable GIF media URL");

        const res = await Native.fetchGifMedia(media.href);
        if (!res.ok) return await fallBackToLink(channelId, gif, res.error);

        let name = media.pathname.split("/").pop()?.replace(/[^\w.-]/g, "") || "gif.gif";
        // most "gifs" are really mp4/webm; mark them so the receiving side
        // plays them gif-style (autoplay, loop, no controls) instead of as a video
        if (!/\.gif\.(mp4|webm)$/i.test(name)) name = name.replace(/\.(mp4|webm)$/i, ".gif.$1");
        const file = new File([res.data as unknown as BlobPart], name, { type: mimeFromFilename(name) });

        // the upload interception encrypts it like any attachment in this channel
        await sendFilesMessage(channelId, [file]);
    } catch (e) {
        // aborts from the upload path (missing keys, locked key) have already
        // notified; anything else should not silently eat the gif
        logger.error("Failed to send gif as encrypted file", e);
        showNotification({ title: "PGP Encryption", body: "Failed to send the GIF. Check the console for details." });
    }
}
