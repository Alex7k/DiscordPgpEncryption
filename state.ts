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
    | { type: "decrypted"; verified: boolean | null; part?: { index: number; total: number; merged: boolean; }; }
    | { type: "continuation"; index: number; total: number; }
    | { type: "pending"; }
    | { type: "failed"; reason: string; };

/**
 * Per-message decryption state, in memory only so plaintext related info never
 * touches disk. Message content itself is swapped in the message store.
 */
export const messageStates = new Map<string, MessagePgpState>();

/** messageId -> channelId of ciphertexts waiting for the private key to be unlocked */
export const pendingMessages = new Map<string, string>();

export interface GroupPart {
    messageId: string;
    channelId: string;
    index: number;
    text: string;
    verified: boolean | null;
}

export interface PartGroup {
    total: number;
    /** Whether the full text currently renders in the first part's message */
    merged: boolean;
    /** By part index */
    parts: Map<number, GroupPart>;
}

/** groupId -> received parts of split messages. Memory only, like messageStates. */
export const partGroups = new Map<string, PartGroup>();

/** messageId -> groupId reverse lookup */
export const messageGroups = new Map<string, string>();

export interface AttachmentState {
    id: string;
    url: string;
    size: number;
    authorId?: string;
    status: "init" | "locked" | "too-large" | "fetching" | "decrypted" | "failed";
    reason?: string;
    /** Object URL of the decrypted bytes; must be revoked when dropped */
    blobUrl?: string;
    filename?: string;
    verified?: boolean | null;
}

/** messageId -> encrypted attachments of that message. Memory only. */
export const attachmentStates = new Map<string, AttachmentState[]>();

export function dropAttachmentStates(messageId: string) {
    const list = attachmentStates.get(messageId);
    if (!list) return;
    for (const att of list) {
        if (att.blobUrl) URL.revokeObjectURL(att.blobUrl);
    }
    attachmentStates.delete(messageId);
}

export function clearMessageState() {
    messageStates.clear();
    pendingMessages.clear();
    partGroups.clear();
    messageGroups.clear();
    for (const messageId of [...attachmentStates.keys()]) dropAttachmentStates(messageId);
}
