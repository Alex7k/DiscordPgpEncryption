/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import definePlugin from "@utils/types";

import { About } from "./components/About";
import { LockIcon, PgpChatBarIcon } from "./components/ChatBarIcon";
import { PgpAccessory } from "./components/PgpAccessory";
import { lock, onUnlock } from "./keyStore";
import { handleLoadMessages, handleMessageCreateOrUpdate, handlePreEdit, handlePreSend, processPendingMessages } from "./messageHandler";
import { tryAutoUnlock } from "./rememberedPassphrase";
import { settings } from "./settings";
import { clearMessageState, loadEnabledChannels } from "./state";

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

    renderMessageAccessory: props => <PgpAccessory message={props.message} />,

    onBeforeMessageSend: handlePreSend,
    onBeforeMessageEdit: handlePreEdit,

    flux: {
        MESSAGE_CREATE: handleMessageCreateOrUpdate,
        MESSAGE_UPDATE: handleMessageCreateOrUpdate,
        LOAD_MESSAGES_SUCCESS: handleLoadMessages
    },

    async start() {
        await loadEnabledChannels();
        // listener first, so an auto-unlock also decrypts anything already queued
        unsubscribeUnlock = onUnlock(processPendingMessages);
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
