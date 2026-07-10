/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { KeySettings } from "./components/KeySettings";

export const settings = definePluginSettings({
    encryptAttachments: {
        type: OptionType.BOOLEAN,
        description: "Encrypt attachments sent in encrypted channels (they upload as generic encrypted.pgp files)",
        default: true
    },
    splitAttachments: {
        type: OptionType.BOOLEAN,
        description: "Split attachments larger than your upload size limit into multiple encrypted parts, sent across as many messages as needed. When off, over-limit files are blocked by Discord as usual",
        default: true
    },
    gifAsFile: {
        type: OptionType.BOOLEAN,
        description: "Send GIF picker GIFs in encrypted channels as encrypted file uploads. Embeds cannot work on encrypted messages, so GIFs otherwise arrive as bare links.",
        default: true
    },
    stickerAsFile: {
        type: OptionType.BOOLEAN,
        description: "Send stickers in encrypted channels as encrypted image files instead of plain stickers. Discord's built-in (lottie) stickers cannot be converted and still send unencrypted, with the usual warning",
        default: true
    },
    autoSplit: {
        type: OptionType.BOOLEAN,
        description: "Automatically split messages that are too long after encryption into multiple encrypted messages",
        default: true
    },
    skipFavoriteDialog: {
        type: OptionType.BOOLEAN,
        description: "Skip the confirmation dialog when favoriting a GIF from an encrypted chat. The dialog explains that favorites are saved to your Discord account settings, outside end-to-end encryption, and shows which site the GIF comes from",
        default: false
    },
    keyManagement: {
        type: OptionType.COMPONENT,
        component: KeySettings
    },
    /**
     * Hosts whose favorite-gif privacy dialog the user already confirmed once.
     * Lives in plugin settings (not DataStore) so Vencord Cloud settings sync
     * carries it, like skipFavoriteDialog above.
     */
    favoriteGifAckHosts: {
        type: OptionType.CUSTOM,
        default: [] as string[]
    }
});
