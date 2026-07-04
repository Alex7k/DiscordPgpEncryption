/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageObject } from "@api/MessageEvents";
import { updateMessage } from "@api/MessageUpdater";
import { showNotification } from "@api/Notifications";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { Message } from "@vencord/discord-types";
import { ChannelStore, FluxDispatcher, MessageStore, UserStore } from "@webpack/common";

import { ensureUnlocked } from "./components/UnlockModal";
import { decryptMessage, encryptMessage, encryptMessageChunks, getPgpKeyPayload, getPgpMessagePayload, MAX_SPLIT_PARTS, parsePartHeader,type PartHeader } from "./crypto";
import { getContacts, getOwnKey, getSessionKey } from "./keyStore";
import { openPgpSettings } from "./openSettings";
import { settings } from "./settings";
import { enabledChannels, messageGroups, messageStates, type PartGroup, partGroups, pendingMessages } from "./state";

const logger = new Logger("PgpEncrypt", "#7289da");

const getMaxMessageLength = () =>
    UserStore.getCurrentUser()?.premiumType === 2 ? 4000 : 2000;

function notify(body: string, onClick?: () => void) {
    showNotification({ title: "PGP Encryption", body, onClick });
}

// #region Encrypt (outgoing)

export async function handlePreSend(channelId: string, messageObj: MessageObject): Promise<void | { cancel: boolean; }> {
    if (!enabledChannels.has(channelId)) return;
    return encryptOutgoing(channelId, messageObj, false);
}

export async function handlePreEdit(channelId: string, messageId: string, messageObj: MessageObject): Promise<void | { cancel: boolean; }> {
    // Re-encrypt edits of messages that were encrypted, or any edit in an enabled channel
    if (!enabledChannels.has(channelId) && !messageStates.has(messageId)) return;
    return encryptOutgoing(channelId, messageObj, true);
}

async function sendChunks(channelId: string, chunks: string[]) {
    for (const chunk of chunks) {
        await sendMessage(channelId, { content: chunk });
    }
}

/** Waits for the message currently being sent to leave first, so the parts stay in order */
function sendChunksSoon(channelId: string, chunks: string[]) {
    if (chunks.length === 0) return;
    setTimeout(() => void sendChunks(channelId, chunks), 300);
}

async function encryptOutgoing(channelId: string, messageObj: MessageObject, isEdit: boolean): Promise<void | { cancel: boolean; }> {
    const { content } = messageObj;
    // Don't touch empty messages, key shares, or already-encrypted content
    if (!content || getPgpKeyPayload(content) !== null || getPgpMessagePayload(content) !== null) return;

    const channel = ChannelStore.getChannel(channelId);
    if (!channel?.isPrivate()) return;

    const ownKey = await getOwnKey();
    if (!ownKey) {
        notify("You don't have a PGP keypair yet. Click here to open the plugin settings and generate one.", openPgpSettings);
        return { cancel: true };
    }

    const contacts = await getContacts();
    const missing = channel.recipients.filter(id => !contacts[id]);
    if (missing.length > 0) {
        const names = missing.map(id => UserStore.getUser(id)?.username ?? id).join(", ");
        notify(`Missing PGP keys for: ${names}. Ask them to share their key, or turn encryption off for this channel.`);
        return { cancel: true };
    }

    const signingKey = await ensureUnlocked();
    if (!signingKey) return { cancel: true };

    try {
        const recipientKeys = [...channel.recipients.map(id => contacts[id].publicKey), ownKey.publicKey];
        const encrypted = await encryptMessage(content, recipientKeys, signingKey);

        const maxLength = getMaxMessageLength();
        if (encrypted.length <= maxLength) {
            messageObj.content = encrypted;
            return;
        }

        if (isEdit) {
            notify(`Edit too long to encrypt: ${encrypted.length}/${maxLength} chars after encryption. An edit cannot be split, shorten it instead.`);
            return { cancel: true };
        }

        const chunks = await encryptMessageChunks(content, recipientKeys, signingKey, maxLength, Math.ceil(encrypted.length / maxLength));
        if (!chunks) {
            notify(`Message too long to encrypt, even split into ${MAX_SPLIT_PARTS} messages. Shorten it.`);
            return { cancel: true };
        }

        if (settings.store.autoSplit) {
            // this message becomes part 1, the rest follow right behind it
            messageObj.content = chunks[0];
            sendChunksSoon(channelId, chunks.slice(1));
            return;
        }

        let clicked = false;
        notify(
            `Message too long to encrypt: ${encrypted.length}/${maxLength} chars after encryption. Click to send it as ${chunks.length} separate encrypted messages.`,
            () => {
                if (clicked) return;
                clicked = true;
                void sendChunks(channelId, chunks);
            }
        );
        return { cancel: true };
    } catch (e) {
        logger.error("Failed to encrypt message", e);
        notify(`Failed to encrypt message: ${e}`);
        return { cancel: true };
    }
}

// #endregion

// #region Decrypt (incoming)

let notifiedLockedThisSession = false;

/**
 * Pushes decrypted content to stores that keep their own copy of a message,
 * like the reply preview cache, which updateMessage does not reach. Partial
 * MESSAGE_UPDATEs are what Discord itself sends for embed unfurls, so stores
 * merge them cleanly. Deferred so it never lands inside an ongoing dispatch.
 */
function broadcastContent(channelId: string, messageId: string, content: string) {
    queueMicrotask(() => FluxDispatcher.dispatch({
        type: "MESSAGE_UPDATE",
        message: { id: messageId, channel_id: channelId, content }
    } as any));
}

export async function tryDecryptMessage(channelId: string, message: Message) {
    const messageId = message.id;
    const payload = getPgpMessagePayload(message.content ?? "");
    if (payload === null) return;

    const ownKey = await getOwnKey();
    if (!ownKey) {
        messageStates.set(messageId, { type: "failed", reason: "You have no PGP keypair" });
        // retried when a keypair is generated, imported, or unlocked
        pendingMessages.set(messageId, channelId);
        updateMessage(channelId, messageId);
        return;
    }

    const privateKey = getSessionKey();
    if (!privateKey) {
        messageStates.set(messageId, { type: "pending" });
        pendingMessages.set(messageId, channelId);
        updateMessage(channelId, messageId);

        if (!notifiedLockedThisSession) {
            notifiedLockedThisSession = true;
            notify("You received encrypted messages. Click to unlock your PGP key.", () => void ensureUnlocked());
        }
        return;
    }

    // Verify the signature against the author's known key, if we have it
    const authorId = message.author?.id;
    let verificationKey: string | undefined;
    if (authorId === UserStore.getCurrentUser()?.id) {
        verificationKey = ownKey.publicKey;
    } else if (authorId) {
        verificationKey = (await getContacts())[authorId]?.publicKey;
    }

    try {
        const { text, verified } = await decryptMessage(payload, privateKey, verificationKey);
        pendingMessages.delete(messageId);

        const part = parsePartHeader(text);
        if (part) {
            applyPart(channelId, messageId, part, verified);
        } else {
            // an edit can turn a former part into a whole message again
            detachFromGroup(messageId);
            messageStates.set(messageId, { type: "decrypted", verified });
            updateMessage(channelId, messageId, { content: text });
            broadcastContent(channelId, messageId, text);
        }
    } catch (e) {
        logger.info(`Failed to decrypt message ${messageId}`, e);
        messageStates.set(messageId, { type: "failed", reason: "Not encrypted to your key" });
        // keep it queued: importing a different keypair from backup may succeed
        pendingMessages.set(messageId, channelId);
        updateMessage(channelId, messageId);
    }
}

/**
 * Records one part of a split message. Until the group is complete the part
 * shows its own text; once every part arrived, the full text renders in the
 * first message and the others collapse to a small stub.
 */
function applyPart(channelId: string, messageId: string, part: PartHeader, verified: boolean | null) {
    let group = partGroups.get(part.groupId);
    if (!group) {
        group = { total: part.total, merged: false, parts: new Map() };
        partGroups.set(part.groupId, group);
    }

    group.parts.set(part.index, { messageId, channelId, index: part.index, text: part.text, verified });
    messageGroups.set(messageId, part.groupId);

    if (group.parts.size >= group.total) {
        mergeGroup(group);
    } else {
        messageStates.set(messageId, { type: "decrypted", verified, part: { index: part.index, total: group.total, merged: false } });
        updateMessage(channelId, messageId, { content: part.text });
        broadcastContent(channelId, messageId, part.text);
    }
}

function mergeGroup(group: PartGroup) {
    const ordered = [...group.parts.values()].sort((a, b) => a.index - b.index);
    const [first, ...rest] = ordered;

    // one bad signature taints the whole text; unknown sender key taints "verified" down to null
    const verified = ordered.some(p => p.verified === false) ? false
        : ordered.every(p => p.verified === true) ? true : null;

    const joined = ordered.map(p => p.text).join("");

    group.merged = true;
    messageStates.set(first.messageId, { type: "decrypted", verified, part: { index: 1, total: group.total, merged: true } });
    updateMessage(first.channelId, first.messageId, { content: joined });
    broadcastContent(first.channelId, first.messageId, joined);

    for (const p of rest) {
        messageStates.set(p.messageId, { type: "continuation", index: p.index, total: group.total });
        updateMessage(p.channelId, p.messageId, { content: "" });
        broadcastContent(p.channelId, p.messageId, "");
    }
}

/**
 * Removes a message from its split group (deleted, or edited into a whole
 * message). A merged group falls back to showing each part individually.
 */
function detachFromGroup(messageId: string) {
    const groupId = messageGroups.get(messageId);
    if (!groupId) return;
    messageGroups.delete(messageId);

    const group = partGroups.get(groupId);
    if (!group) return;

    for (const [index, p] of group.parts) {
        if (p.messageId === messageId) group.parts.delete(index);
    }
    if (group.parts.size === 0) {
        partGroups.delete(groupId);
        return;
    }

    if (group.merged) {
        group.merged = false;
        for (const p of group.parts.values()) {
            messageStates.set(p.messageId, { type: "decrypted", verified: p.verified, part: { index: p.index, total: group.total, merged: false } });
            updateMessage(p.channelId, p.messageId, { content: p.text });
            broadcastContent(p.channelId, p.messageId, p.text);
        }
    }
}

/** Retry everything that arrived while the private key was locked. Called on unlock. */
export function processPendingMessages() {
    const entries = [...pendingMessages.entries()];
    pendingMessages.clear();

    for (const [messageId, channelId] of entries) {
        const message = MessageStore.getMessage(channelId, messageId);
        if (message) void tryDecryptMessage(channelId, message);
    }
}

// #endregion

/**
 * The reply preview store caches its own ciphertext copy of the referenced
 * message when a reply arrives. Best effort: re-broadcast the plaintext if we
 * already have it, otherwise decrypt the copy the reply brought along.
 */
function refreshReferencedMessage(fallbackChannelId: string, message: Message) {
    const ref = (message as any).message_reference ?? message.messageReference;
    const refId = ref?.message_id;
    if (!refId) return;
    const refChannelId = ref.channel_id ?? fallbackChannelId;

    const state = messageStates.get(refId);
    if (state?.type === "decrypted" || state?.type === "continuation") {
        const stored = MessageStore.getMessage(refChannelId, refId);
        if (stored) {
            broadcastContent(refChannelId, refId, stored.content);
            return;
        }
    }

    const raw = (message as any).referenced_message ?? (message as any).referencedMessage;
    if (raw?.id) void tryDecryptMessage(refChannelId, raw);
}

// #region Flux handlers

export function handleMessageCreateOrUpdate(event: { channelId?: string; message?: Message; }) {
    const { message } = event;
    const channelId = event.channelId ?? (message as any)?.channel_id;
    if (!message?.id || !channelId) return;

    void tryDecryptMessage(channelId, message);
    refreshReferencedMessage(channelId, message);
}

export function handleLoadMessages(event: { channelId?: string; messages?: Message[]; }) {
    const { channelId, messages } = event;
    if (!channelId || !Array.isArray(messages)) return;

    for (const message of messages) {
        if (!message?.id) continue;
        void tryDecryptMessage(channelId, message);
        refreshReferencedMessage(channelId, message);
    }
}

export function handleMessageDelete(event: { id?: string; }) {
    if (!event.id) return;
    messageStates.delete(event.id);
    pendingMessages.delete(event.id);
    detachFromGroup(event.id);
}

// #endregion
