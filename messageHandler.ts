/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageObject } from "@api/MessageEvents";
import { updateMessage } from "@api/MessageUpdater";
import { showNotification } from "@api/Notifications";
import { Logger } from "@utils/Logger";
import { Message } from "@vencord/discord-types";
import { ChannelStore, MessageStore, UserStore } from "@webpack/common";

import { ensureUnlocked } from "./components/UnlockModal";
import { decryptMessage, encryptMessage, getPgpKeyPayload, getPgpMessagePayload } from "./crypto";
import { getContacts, getOwnKey, getSessionKey } from "./keyStore";
import { openPgpSettings } from "./openSettings";
import { enabledChannels, messageStates, pendingMessages } from "./state";

const logger = new Logger("PgpEncrypt", "#7289da");

const getMaxMessageLength = () =>
    UserStore.getCurrentUser()?.premiumType === 2 ? 4000 : 2000;

function notify(body: string, onClick?: () => void) {
    showNotification({ title: "PGP Encryption", body, onClick });
}

// #region Encrypt (outgoing)

export async function handlePreSend(channelId: string, messageObj: MessageObject): Promise<void | { cancel: boolean; }> {
    if (!enabledChannels.has(channelId)) return;
    return encryptOutgoing(channelId, messageObj);
}

export async function handlePreEdit(channelId: string, messageId: string, messageObj: MessageObject): Promise<void | { cancel: boolean; }> {
    // Re-encrypt edits of messages that were encrypted, or any edit in an enabled channel
    if (!enabledChannels.has(channelId) && !messageStates.has(messageId)) return;
    return encryptOutgoing(channelId, messageObj);
}

async function encryptOutgoing(channelId: string, messageObj: MessageObject): Promise<void | { cancel: boolean; }> {
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
        if (encrypted.length > maxLength) {
            notify(`Message too long to encrypt: ${encrypted.length}/${maxLength} chars after encryption. Shorten it or split it up.`);
            return { cancel: true };
        }

        messageObj.content = encrypted;
    } catch (e) {
        logger.error("Failed to encrypt message", e);
        notify(`Failed to encrypt message: ${e}`);
        return { cancel: true };
    }
}

// #endregion

// #region Decrypt (incoming)

let notifiedLockedThisSession = false;

export async function tryDecryptMessage(channelId: string, message: Message) {
    const messageId = message.id;
    const payload = getPgpMessagePayload(message.content ?? "");
    if (payload === null) return;

    const ownKey = await getOwnKey();
    if (!ownKey) {
        messageStates.set(messageId, { type: "failed", reason: "You have no PGP keypair" });
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
        messageStates.set(messageId, { type: "decrypted", verified });
        pendingMessages.delete(messageId);
        updateMessage(channelId, messageId, { content: text });
    } catch (e) {
        logger.info(`Failed to decrypt message ${messageId}`, e);
        messageStates.set(messageId, { type: "failed", reason: "Not encrypted to your key" });
        pendingMessages.delete(messageId);
        updateMessage(channelId, messageId);
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

// #region Flux handlers

export function handleMessageCreateOrUpdate(event: { channelId?: string; message?: Message; }) {
    const { message } = event;
    const channelId = event.channelId ?? (message as any)?.channel_id;
    if (!message?.id || !channelId) return;

    void tryDecryptMessage(channelId, message);
}

export function handleLoadMessages(event: { channelId?: string; messages?: Message[]; }) {
    const { channelId, messages } = event;
    if (!channelId || !Array.isArray(messages)) return;

    for (const message of messages) {
        if (message?.id) void tryDecryptMessage(channelId, message);
    }
}

// #endregion
