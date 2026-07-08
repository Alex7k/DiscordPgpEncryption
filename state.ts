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

export async function clearEnabledChannels() {
    enabledChannels.clear();
    await DataStore.del(ENABLED_CHANNELS);
}

export type MessagePgpState =
    | { type: "decrypted"; verified: boolean | null; part?: { index: number; total: number; merged: boolean; }; }
    | { type: "continuation"; index: number; total: number; }
    /** Ciphertext arrived and the async decrypt is in flight; hides the raw ciphertext until a final state replaces this */
    | { type: "decrypting"; }
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

export interface AttachmentGroupPart {
    messageId: string;
    channelId: string;
    attachmentId: string;
    url: string;
    /** Encrypted size of this part */
    size: number;
}

/** One file that was split into several encrypted part uploads */
export interface AttachmentGroup {
    id: string;
    total: number;
    authorId?: string;
    /** By part index (1-based, from the outer filename hint) */
    parts: Map<number, AttachmentGroupPart>;
    status: "waiting" | "locked" | "too-large" | "fetching" | "decrypted" | "failed";
    reason?: string;
    /** 1-based index of the part currently being fetched and decrypted */
    progress?: number;
    /** Sum of the encrypted part sizes until decrypted, then the file's size */
    size: number;
    /** Object URL of the reassembled decrypted file; must be revoked when dropped */
    blobUrl?: string;
    filename?: string;
    verified?: boolean | null;
}

/** groupId -> split attachment reassembly state. Memory only. */
export const attachmentGroups = new Map<string, AttachmentGroup>();

/** messageId -> ids of the groups that message holds parts of */
export const messageAttachmentGroups = new Map<string, Set<string>>();

/** Forgets a deleted message's parts; a group with no parts left is dropped */
export function dropMessageFromGroups(messageId: string) {
    const groupIds = messageAttachmentGroups.get(messageId);
    if (!groupIds) return;
    messageAttachmentGroups.delete(messageId);

    for (const groupId of groupIds) {
        const group = attachmentGroups.get(groupId);
        if (!group) continue;
        for (const [index, part] of group.parts) {
            if (part.messageId === messageId) group.parts.delete(index);
        }
        if (group.parts.size === 0) {
            if (group.blobUrl) URL.revokeObjectURL(group.blobUrl);
            attachmentGroups.delete(groupId);
        }
    }
}

export function clearMessageState() {
    messageStates.clear();
    pendingMessages.clear();
    partGroups.clear();
    messageGroups.clear();
    for (const messageId of [...attachmentStates.keys()]) dropAttachmentStates(messageId);
    for (const group of attachmentGroups.values()) {
        if (group.blobUrl) URL.revokeObjectURL(group.blobUrl);
    }
    attachmentGroups.clear();
    messageAttachmentGroups.clear();
}
