/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import definePlugin from "@utils/types";
import { SelectedChannelStore } from "@webpack/common";

import { installUploadInterception, uninstallUploadInterception } from "./attachments";
import { About } from "./components/About";
import { LockIcon, PgpChatBarIcon } from "./components/ChatBarIcon";
import { PgpAccessory } from "./components/PgpAccessory";
import { MAX_SPLIT_PARTS } from "./crypto";
import { installGifPickerShiftTracking, keepGifPickerOpen, sendGifAsFile, shouldSendGifAsFile, uninstallGifPickerShiftTracking } from "./gifUpload";
import { lock, onKeyChange } from "./keyStore";
import { handleLoadMessages, handleMessageCreateOrUpdate, handleMessageDelete, handlePreEdit, handlePreSend, installSendGuard, processPendingMessages, uninstallSendGuard } from "./messageHandler";
import { tryAutoUnlock } from "./rememberedPassphrase";
import { settings } from "./settings";
import { clearMessageState, enabledChannels, loadEnabledChannels } from "./state";

let unsubscribeUnlock: (() => void) | undefined;

export default definePlugin({
    name: "PgpEncrypt",
    description: "Seamlessly send and receive PGP end-to-end encrypted messages",
    authors: [{ name: "alexxisreal", id: 766405189631475743n }],
    settings,
    settingsAboutComponent: About,

    chatBarButton: {
        icon: LockIcon,
        render: PgpChatBarIcon
    },

    patches: [
        // Discord blocks over-limit messages in the composer before any send
        // hook runs, so encrypt-and-split never gets a chance. Raise the limit
        // check in PGP-enabled channels; the pre-send handler splits there.
        {
            find: "Message Too Long Alert",
            replacement: {
                match: /let (\i)=(\i\?\i\.\i:\i\.\i);/,
                replace: "let $1=$self.composerLimit($2);"
            }
        },
        // The media viewer's image component runs every src through getSrc(),
        // which appends resize/format query params. A blob: URL with a query
        // string never resolves, so decrypted images showed up blank in the
        // viewer. Same patch site as core FixImagesQuality; getSrc is sometimes
        // invoked without a receiver, hence this?. and the $self helper.
        {
            find: ".handleImageLoad)",
            replacement: {
                match: /getSrc\(\i\)\{/,
                replace: "$&var vcPgpSrc=$self.getBlobSrc(this?.props);if(vcPgpSrc)return vcPgpSrc;"
            }
        },
        // The GIF picker sends a plain Tenor/Giphy link, which can never embed
        // in an encrypted channel (the server only sees ciphertext, so it cannot
        // unfurl). Intercept the selection and send the GIF as an encrypted file
        // instead; same patch site as the GifPaste core plugin, guard included.
        // The handler used to take only the gif (`gif=>{`); since Sep 2026 it
        // takes a second argument (`(gif,x)=>{`). Match both.
        {
            find: "handleSelectGIF=",
            replacement: {
                match: /handleSelectGIF=\(?(\i)(?:,\i)?\)?=>\{/,
                replace: "$&if(!this?.props?.className&&$self.shouldSendGifAsFile())return $self.sendGifAsFile($1);"
            }
        },
        // Shift+click in the GIF picker sends without closing it, like the emoji
        // picker already does. Vanilla closes the picker twice in the chat input
        // module: synchronously in its GIF callback (anchored by the analytics
        // payload), and again in the submit hook once the send promise resolves.
        // The async one cannot read the modifier state later, so the decision
        // is captured into a local when submit is called (its 4th parameter is
        // isGif). The encrypted path checks the same predicate itself.
        {
            find: 'source_object:"GIF Picker",gif_url:',
            replacement: [
                {
                    match: /(source_object:"GIF Picker",gif_url:.{0,200}?\})(\(0,\i\.\i\)\(\)),/,
                    replace: "$1$self.keepGifPickerOpen()||$2,"
                },
                {
                    match: /(\i\.useCallback\(\(\i,\i,\i,(\i),\i,\i\)=>\{if\(\i\)return;\i\(!0\);)/,
                    replace: "$1var vcPgpKeepPicker=$2&&$self.keepGifPickerOpen();"
                },
                {
                    match: /(isGif:\i,gifMetadata:\i\}\)\.then\(\i=>\{.{0,300}?)\(0,(\i\.\i)\)\(\),/,
                    replace: "$1vcPgpKeepPicker||(0,$2)(),"
                }
            ]
        },
        // Discord rejects an over-limit file at attach time with a Nitro upsell,
        // before our upload() hook can encrypt and split it. Two gates run: a
        // per-file one (maxFileSize(guildId)) and a total-message-size one
        // (a hardcoded 500 MB cap). Lift both in PGP-enabled channels so the
        // file attaches, then the upload interception splits it into parts.
        {
            find: '"getGuildMaxFileSize"',
            replacement: [
                {
                    match: /(function \i\(\i\)\{let \i=\i\.\i\.getCurrentUser\(\),\i=\i\.\i\.getUserMaxFileSize\(\i\);)/,
                    replace: "$1if($self.uploadLimitBypassed())return Number.MAX_SAFE_INTEGER;"
                },
                {
                    match: /(function \i\(\)\{let \i=\i\.\i\.getCurrentUser\(\);return null!=\i&&\i\.isStaff\(\),)(524288e3\})/,
                    replace: "$1$self.uploadLimitBypassed()?Number.MAX_SAFE_INTEGER:$2"
                }
            ]
        }
    ],

    /** True while an oversized upload in the active channel should be allowed through to be split */
    uploadLimitBypassed(): boolean {
        if (!settings.store.encryptAttachments || !settings.store.splitAttachments) return false;
        const channelId = SelectedChannelStore.getChannelId();
        return !!channelId && enabledChannels.has(channelId);
    },

    getBlobSrc(props?: { src?: unknown; }): string | undefined {
        try {
            const { src } = props ?? {};
            if (typeof src === "string" && src.startsWith("blob:")) return src;
        } catch { }
        return undefined;
    },

    shouldSendGifAsFile,
    sendGifAsFile,
    keepGifPickerOpen,

    composerLimit(realLimit: number): number {
        const channelId = SelectedChannelStore.getChannelId();
        if (!channelId || !enabledChannels.has(channelId)) return realLimit;
        // roughly what MAX_SPLIT_PARTS encrypted parts can carry; anything
        // beyond still gets a clear "shorten it" notification
        return realLimit * MAX_SPLIT_PARTS / 2;
    },

    renderMessageAccessory: props => <PgpAccessory message={props.message} />,

    onBeforeMessageSend: handlePreSend,
    onBeforeMessageEdit: handlePreEdit,

    flux: {
        MESSAGE_CREATE: handleMessageCreateOrUpdate,
        MESSAGE_UPDATE: handleMessageCreateOrUpdate,
        MESSAGE_DELETE: handleMessageDelete,
        LOAD_MESSAGES_SUCCESS: handleLoadMessages
    },

    async start() {
        // listener first, so an auto-unlock also decrypts anything already queued
        unsubscribeUnlock = onKeyChange(processPendingMessages);
        // kicked off before the first await: flux events are subscribed as soon
        // as start() yields, and incoming messages check this attempt to avoid
        // a spurious "click to unlock" nag while it is still running
        void tryAutoUnlock();
        await loadEnabledChannels();
        installUploadInterception();
        installSendGuard();
        installGifPickerShiftTracking();
    },

    stop() {
        uninstallUploadInterception();
        uninstallSendGuard();
        uninstallGifPickerShiftTracking();
        unsubscribeUnlock?.();
        unsubscribeUnlock = undefined;
        // Don't keep the decrypted private key or any plaintext state in memory
        // once the plugin is disabled
        lock();
        clearMessageState();
    }
});
