/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

const ENABLED_CHANNELS = "PgpEncrypt_enabledChannels";

/** Channels the user toggled encryption on for. Mirrored to DataStore. */
export const enabledChannels = new Set<string>();

export async function loadEnabledChannels() {
    enabledChannels.clear();
    (await DataStore.get<string[]>(ENABLED_CHANNELS))?.forEach(id => enabledChannels.add(id));
}

export async function setChannelEnabled(channelId: string, enabled: boolean) {
    if (enabled) enabledChannels.add(channelId);
    else enabledChannels.delete(channelId);
    await DataStore.set(ENABLED_CHANNELS, [...enabledChannels]);
}

export type MessagePgpState =
    | { type: "decrypted"; verified: boolean | null; }
    | { type: "pending"; }
    | { type: "failed"; reason: string; };

/**
 * Per-message decryption state, in memory only so plaintext related info never
 * touches disk. Message content itself is swapped in the message store.
 */
export const messageStates = new Map<string, MessagePgpState>();

/** messageId -> channelId of ciphertexts waiting for the private key to be unlocked */
export const pendingMessages = new Map<string, string>();

export function clearMessageState() {
    messageStates.clear();
    pendingMessages.clear();
}
