/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { Logger } from "@utils/Logger";
import { showToast, StickersStore } from "@webpack/common";

import { sendFilesMessage } from "./attachments";
import { settings } from "./settings";
import { enabledChannels } from "./state";

const logger = new Logger("PgpEncrypt", "#7289da");

// sticker format_type values: 1 = PNG, 2 = APNG, 3 = LOTTIE, 4 = GIF
const STICKER_EXT: Record<number, string> = { 1: "png", 2: "png", 4: "gif" };

export function shouldSendStickersAsFiles(channelId: string): boolean {
    return settings.store.stickerAsFile
        && settings.store.encryptAttachments
        && enabledChannels.has(channelId);
}

/**
 * Converts the stickers of an outgoing message into encrypted file uploads.
 * Called from the pre-send hook; supported stickers are removed from the
 * message and sent as their own encrypted messages, unsupported ones (lottie,
 * i.e. Discord's built-in packs, which are vector animations with no image
 * form) are left in place to send normally, covered by the existing
 * "sticker is NOT encrypted" warning.
 */
export function convertStickersToFiles(channelId: string, stickerIds: string[]) {
    const keep: string[] = [];

    for (const id of stickerIds) {
        const sticker = StickersStore.getStickerById(id) as any;
        const ext = sticker && STICKER_EXT[sticker.format_type ?? sticker.formatType];
        if (!ext) {
            keep.push(id);
            continue;
        }
        showToast("Encrypting sticker…");
        void sendStickerFile(channelId, sticker, ext);
    }

    // mutated in place so the composer sends only what we did not take over
    stickerIds.length = 0;
    stickerIds.push(...keep);
}

async function sendStickerFile(channelId: string, sticker: any, ext: string) {
    try {
        // must be the media proxy: cdn.discordapp.com/stickers/ sends no CORS
        // headers so the renderer cannot fetch it. passthrough keeps APNGs
        // animated instead of the proxy re-encoding them to a static frame
        const apng = (sticker.format_type ?? sticker.formatType) === 2;
        const res = await fetch(`https://media.discordapp.net/stickers/${sticker.id}.${ext}?size=320${apng ? "&passthrough=true" : ""}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = await res.arrayBuffer();

        // the .sticker. marker makes the receiving side render it at the
        // uniform size real stickers get, instead of as a free-size image
        const name = `${String(sticker.name ?? "sticker").replace(/[^\w.-]/g, "")}.sticker.${ext}`;
        const file = new File([bytes], name, { type: ext === "gif" ? "image/gif" : "image/png" });

        // the upload interception encrypts it like any attachment in this channel
        await sendFilesMessage(channelId, [file]);
    } catch (e) {
        // never fall back to sending the sticker unencrypted
        logger.error(`Failed to send sticker ${sticker.id} as encrypted file`, e);
        showNotification({ title: "PGP Encryption", body: `Could not send the sticker "${sticker.name}" encrypted. It was not sent.` });
    }
}
