/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import definePlugin from "@utils/types";
import { SelectedChannelStore } from "@webpack/common";

import { About } from "./components/About";
import { LockIcon, PgpChatBarIcon } from "./components/ChatBarIcon";
import { PgpAccessory } from "./components/PgpAccessory";
import { MAX_SPLIT_PARTS } from "./crypto";
import { lock, onKeyChange } from "./keyStore";
import { handleLoadMessages, handleMessageCreateOrUpdate, handleMessageDelete, handlePreEdit, handlePreSend, processPendingMessages } from "./messageHandler";
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

    // Discord blocks over-limit messages in the composer before any send hook
    // runs, so encrypt-and-split never gets a chance. Raise the limit check in
    // PGP-enabled channels; the pre-send handler splits the plaintext there.
    patches: [
        {
            find: "Message Too Long Alert",
            replacement: {
                match: /let (\i)=(\i\?\i\.\i:\i\.\i);/,
                replace: "let $1=$self.composerLimit($2);"
            }
        }
    ],

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
        await loadEnabledChannels();
        // listener first, so an auto-unlock also decrypts anything already queued
        unsubscribeUnlock = onKeyChange(processPendingMessages);
        void tryAutoUnlock();
    },

    stop() {
        unsubscribeUnlock?.();
        unsubscribeUnlock = undefined;
        // Don't keep the decrypted private key or any plaintext state in memory
        // once the plugin is disabled
        lock();
        clearMessageState();
    }
});
