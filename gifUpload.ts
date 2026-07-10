/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import { ExpressionPickerStore, SelectedChannelStore, showToast, UserSettingsActionCreators } from "@webpack/common";

import { mimeFromFilename, packSourceUrl, sendFilesMessage } from "./attachments";
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
 * Parses a candidate into a URL if it points at fetchable media. Any https
 * host is fine, IP-safety-wise: this URL only gets fetched on the sender's
 * machine after the sender clicked the gif in their own picker — which already
 * loaded this exact URL to render the preview. Favorites can live on any host
 * (fxtwitter, imgur, ...), not just Tenor/Giphy. The recipient never fetches.
 */
function asAllowedMediaUrl(raw: unknown): URL | null {
    if (typeof raw !== "string") return null;
    try {
        // picker search results carry protocol-relative urls ("//static.klipy.com/...")
        const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
        if (url.protocol !== "https:" || !MEDIA_EXT_RE.test(url.pathname)) return null;
        return url;
    } catch {
        return null;
    }
}

function isDiscordProxyHost(host: string): boolean {
    return host === "media.discordapp.net" || /^images-ext-\d+\.discordapp\.net$/.test(host);
}

/**
 * Best media URL of a picked gif. Discord-proxied URLs win over direct
 * provider URLs: fetching via the proxy tells the provider nothing (matching
 * what vanilla Discord exposes — the provider sees preview browsing, but not
 * which gif was picked). Within the same host class, a real .gif beats the
 * mp4 preview.
 */
function pickMediaUrl(gif: PickedGif): URL | null {
    const candidates = [gif.gifSrc, gif.gif_src, gif.src, gif.url]
        .map(asAllowedMediaUrl)
        .filter((url): url is URL => url !== null);

    const rank = (url: URL) =>
        (isDiscordProxyHost(url.hostname) ? 0 : 2) + (/\.gif$/i.test(url.pathname) ? 0 : 1);
    return candidates.sort((a, b) => rank(a) - rank(b))[0] ?? null;
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
    // the download + encrypt + upload takes a few seconds with nothing visible
    showToast("Encrypting GIF…");
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

/**
 * Every favorites-map key that refers to this gif. Vanilla-starred favorites
 * are keyed by the gif's canonical url (e.g. the tenor page), ours by the
 * media url; a favorite from any origin also carries the media url in src.
 */
function favoriteKeysFor(gifs: Record<string, any>, sourceUrl: string, pageUrl?: string): string[] {
    return Object.entries(gifs)
        .filter(([key, gif]) => key === sourceUrl || key === pageUrl || gif?.src === sourceUrl)
        .map(([key]) => key);
}

/**
 * Adds a received gif to the user's native Discord favorites, by writing to
 * the same FrecencyUserSettings proto the picker's star updates — keyed by the
 * canonical URL when known, like vanilla starring.
 * NOTE: this deliberately steps outside e2ee — the URLs land in the user's
 * server-synced Discord settings, exactly like starring any vanilla gif.
 */
export function addGifToFavorites(sourceUrl: string, pageUrl: string | undefined, width: number, height: number): boolean {
    try {
        const creators = UserSettingsActionCreators.FrecencyUserSettingsActionCreators;
        // frecency proto format enum: 1 = IMAGE, 2 = VIDEO. Only real video
        // containers are VIDEO — animated webp/gif are IMAGE, like vanilla
        const format = /\.(mp4|webm)$/i.test(new URL(sourceUrl).pathname) ? 2 : 1;

        const existing = creators.getCurrentValue()?.favoriteGifs?.gifs ?? {};
        const maxOrder = Math.max(0, ...Object.values(existing).map((g: any) => g?.order ?? 0));

        creators.updateAsync("favoriteGifs", (favoriteGifs: any) => {
            favoriteGifs.gifs ??= {};
            favoriteGifs.gifs[pageUrl ?? sourceUrl] = {
                format,
                src: sourceUrl,
                width: width || 220,
                height: height || 220,
                order: maxOrder + 1
            };
        }, 0);
        return true;
    } catch (e) {
        logger.error("Failed to add gif to favorites", e);
        return false;
    }
}

/**
 * The picker can only render favorite previews from CSP-allowed hosts. For a
 * favorite on some other host (e.g. gif.fxtwitter.com), offer Vencord's
 * consent-gated per-host CSP override so the preview can load; without it the
 * favorite still works, just with a blank tile. Videos are skipped: media-src
 * cannot be overridden.
 */
export async function offerPreviewCspOverride(sourceUrl: string) {
    try {
        // no CSP management on web builds (VencordNative.csp is an empty stub);
        // the browser uses discord.com's own CSP and we cannot change it
        if (typeof VencordNative.csp?.isDomainAllowed !== "function") return;

        const url = new URL(sourceUrl);
        if (/\.(mp4|webm)$/i.test(url.pathname)) return;
        if (await VencordNative.csp.isDomainAllowed(sourceUrl, ["img-src"])) return;

        const res = await VencordNative.csp.requestAddOverride(sourceUrl, ["img-src"], "PgpEncrypt");
        const body = res === "ok"
            ? `${url.host} allowed. Fully restart Discord (not just reload) for its favorite previews to load.`
            : res === "unchecked"
                ? "The trust checkbox was not ticked, so the host was not allowed. The favorite works, but its picker preview will stay blank."
                : res === "cancelled"
                    ? "Favorite saved. Its picker preview will stay blank since the host was not allowed."
                    : `Could not add the permission (${res}). Check the CSP settings in Vencord settings.`;
        showNotification({ title: "PGP Encryption", body });
    } catch (e) {
        logger.warn("Failed to offer CSP override for gif preview", e);
    }
}

/** Whether this gif is in the user's favorites, however it got starred */
export function isGifFavorited(sourceUrl: string, pageUrl?: string): boolean {
    try {
        const gifs = UserSettingsActionCreators.FrecencyUserSettingsActionCreators
            .getCurrentValue()?.favoriteGifs?.gifs ?? {};
        return favoriteKeysFor(gifs, sourceUrl, pageUrl).length > 0;
    } catch {
        return false;
    }
}

export function removeGifFromFavorites(sourceUrl: string, pageUrl?: string): boolean {
    try {
        UserSettingsActionCreators.FrecencyUserSettingsActionCreators.updateAsync("favoriteGifs", (favoriteGifs: any) => {
            if (!favoriteGifs.gifs) return;
            for (const key of favoriteKeysFor(favoriteGifs.gifs, sourceUrl, pageUrl)) {
                delete favoriteGifs.gifs[key];
            }
        }, 0);
        return true;
    } catch (e) {
        logger.error("Failed to remove gif from favorites", e);
        return false;
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
        // carry the source inside the encrypted metadata so recipients can
        // favorite it: the media URL exactly as the picker served it (vanilla
        // favorites store the Discord-proxied form too; /external/ signatures
        // are stable) plus the gif's canonical identity URL, which is what
        // Discord's favorites map is keyed by
        const identity = typeof gif.url === "string" && gif.url.startsWith("https://") ? gif.url : undefined;
        name = packSourceUrl(name, media.href, identity);
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
