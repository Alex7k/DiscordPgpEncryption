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
    autoSplit: {
        type: OptionType.BOOLEAN,
        description: "Automatically split messages that are too long after encryption into multiple encrypted messages",
        default: false
    },
    keyManagement: {
        type: OptionType.COMPONENT,
        component: KeySettings
    }
});
