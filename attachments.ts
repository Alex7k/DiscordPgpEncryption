/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { updateMessage } from "@api/MessageUpdater";
import { showNotification } from "@api/Notifications";
import { Logger } from "@utils/Logger";
import { CloudUpload, Message, MessageAttachment } from "@vencord/discord-types";
import { ChannelStore, MessageStore, UserStore } from "@webpack/common";

import { ensureUnlocked } from "./components/UnlockModal";
import { decryptFileBytes, encryptFileBytes } from "./crypto";
import { getContacts, getOwnKey, getSessionKey } from "./keyStore";
import { openPgpSettings } from "./openSettings";
import { settings } from "./settings";
import { type AttachmentState, attachmentStates, enabledChannels, pendingMessages } from "./state";

const logger = new Logger("PgpEncrypt", "#7289da");

// The CDN only sends CORS headers for files it classifies as images by
// extension, and its media proxy re-encodes anything else, so a plain ".pgp"
// upload can never be fetched back for decryption. We give the ciphertext a
// ".png" extension so the pristine cdn copy is CORS-enabled, keep isImage
// false so Discord's client does not try to re-compress it, and always fetch
// from the original url (never the re-encoding media proxy).
export const ENCRYPTED_FILENAME = "encrypted.pgp.png";
/** Bigger files are click-to-decrypt so scrolling old media doesn't eat memory */
const AUTO_DECRYPT_MAX_BYTES = 50 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", flac: "audio/flac", m4a: "audio/mp4",
    pdf: "application/pdf", txt: "text/plain"
};

export function mimeFromFilename(filename: string): string {
    const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
    return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

// matches the current ".pgp.png" as well as older ".pgp" uploads
export const isPgpAttachment = (attachment: { filename?: string; }) => /\.pgp(\.\w+)?$/i.test(attachment.filename ?? "");

function notify(body: string, onClick?: () => void) {
    showNotification({ title: "PGP Encryption", body, onClick });
}

// #region Encrypt (outgoing uploads)

/**
 * Called from the uploadFiles patch before anything leaves the machine.
 * Replaces each upload's bytes with signed ciphertext; the real filename is
 * hidden inside the encrypted blob. Throws to abort the upload entirely
 * rather than ever letting plaintext through.
 */
export async function encryptUploads(uploads: CloudUpload[]) {
    const targets = uploads.filter(u =>
        settings.store.encryptAttachments && enabledChannels.has(u.channelId) && u.item?.file);
    if (targets.length === 0) return;

    const ownKey = await getOwnKey();
    if (!ownKey) {
        notify("Attachment not sent: you have no PGP keypair. Click here to open the plugin settings.", openPgpSettings);
        throw new Error("PgpEncrypt: no keypair, upload aborted");
    }
    const contacts = await getContacts();

    const signingKey = await ensureUnlocked();
    if (!signingKey) throw new Error("PgpEncrypt: key locked, upload aborted");

    for (const upload of targets) {
        const channel = ChannelStore.getChannel(upload.channelId);
        if (!channel?.isPrivate()) continue;

        const missing = channel.recipients.filter(id => !contacts[id]);
        if (missing.length > 0) {
            const names = missing.map(id => UserStore.getUser(id)?.username ?? id).join(", ");
            notify(`Attachment not sent: missing PGP keys for ${names}.`);
            throw new Error("PgpEncrypt: missing recipient keys, upload aborted");
        }

        const recipientKeys = [...channel.recipients.map(id => contacts[id].publicKey), ownKey.publicKey];
        const { file } = upload.item;
        const bytes = new Uint8Array(await file.arrayBuffer());
        const encryptedBytes = await encryptFileBytes(bytes, file.name, recipientKeys, signingKey);

        // image/png extension + type so the cdn serves it with CORS headers,
        // but isImage stays false so the client uploads the exact bytes
        upload.item.file = new File([encryptedBytes as unknown as BlobPart], ENCRYPTED_FILENAME, { type: "image/png" });
        upload.filename = ENCRYPTED_FILENAME;
        upload.mimeType = "image/png";
        upload.isImage = false;
        upload.isVideo = false;
        // alt text would sit in the message payload in plaintext
        upload.description = null;
    }
}

// #endregion

// #region Decrypt (incoming attachments)

export function handleEncryptedAttachments(channelId: string, message: Message) {
    const encrypted = (message.attachments ?? []).filter(isPgpAttachment);
    if (encrypted.length === 0) return;

    let list = attachmentStates.get(message.id);
    if (!list) {
        list = [];
        attachmentStates.set(message.id, list);
    }
    for (const attachment of encrypted) {
        if (!list.some(s => s.id === attachment.id)) {
            list.push({
                id: attachment.id,
                url: attachment.url,
                size: attachment.size ?? 0,
                authorId: message.author?.id,
                status: "init"
            });
        }
    }

    void processAttachments(channelId, message.id);
}

async function processAttachments(channelId: string, messageId: string) {
    const list = attachmentStates.get(messageId);
    if (!list) return;

    let changed = false;
    for (const att of list) {
        if (att.status !== "init" && att.status !== "locked") continue;
        changed = true;

        if (!await getOwnKey()) {
            att.status = "failed";
            att.reason = "You have no PGP keypair";
            // retried when a keypair is generated or imported
            pendingMessages.set(messageId, channelId);
            continue;
        }
        if (!getSessionKey()) {
            att.status = "locked";
            pendingMessages.set(messageId, channelId);
            continue;
        }
        if (att.size > AUTO_DECRYPT_MAX_BYTES) {
            att.status = "too-large";
            continue;
        }
        void decryptAttachment(channelId, messageId, att);
    }
    if (changed) updateMessage(channelId, messageId);
}

/**
 * Fetches the pristine ciphertext from the cdn url. Never the proxy_url: the
 * media proxy re-encodes attachments and would corrupt the bytes.
 */
async function fetchCiphertext(att: AttachmentState): Promise<Uint8Array> {
    const response = await fetch(att.url);
    if (!response.ok) throw new Error(`download failed (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
}

/** Fetches the ciphertext from the CDN, decrypts it, and swaps in a blob URL */
export async function decryptAttachment(channelId: string, messageId: string, att: AttachmentState) {
    att.status = "fetching";
    updateMessage(channelId, messageId);

    try {
        const privateKey = getSessionKey();
        if (!privateKey) throw new Error("your PGP key is locked");

        const bytes = await fetchCiphertext(att);

        let verificationKey: string | undefined;
        if (att.authorId === UserStore.getCurrentUser()?.id) {
            verificationKey = (await getOwnKey())?.publicKey;
        } else if (att.authorId) {
            verificationKey = (await getContacts())[att.authorId]?.publicKey;
        }

        const { data, filename, verified } = await decryptFileBytes(bytes, privateKey, verificationKey);

        if (att.blobUrl) URL.revokeObjectURL(att.blobUrl);
        att.blobUrl = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type: mimeFromFilename(filename) }));
        att.filename = filename;
        att.verified = verified;
        att.status = "decrypted";

        stripAttachment(channelId, messageId, att.id);
    } catch (e) {
        logger.info(`Failed to decrypt attachment ${att.id}`, e);
        att.status = "failed";
        att.reason = e instanceof Error ? e.message : String(e);
    }
    updateMessage(channelId, messageId);
}

/** Removes the raw encrypted.pgp file card; the accessory renders the content instead */
function stripAttachment(channelId: string, messageId: string, attachmentId: string) {
    const stored = MessageStore.getMessage(channelId, messageId);
    if (!stored?.attachments) return;

    updateMessage(channelId, messageId, {
        attachments: stored.attachments.filter((a: MessageAttachment) => a.id !== attachmentId)
    });
}

// #endregion
